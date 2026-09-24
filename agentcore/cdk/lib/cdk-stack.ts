import {
  AgentCoreApplication,
  AgentCoreMcp,
  AgentCorePaymentManager,
  AgentCorePaymentConnector,
  type AgentCoreProjectSpec,
  type AgentCoreMcpSpec,
  type CustomJWTAuthorizerConfig,
  type HarnessDeploymentConfig,
} from '@aws/agentcore-cdk';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as path from 'path';
import { Construct } from 'constructs';

/**
 * Harness deployment config: role-scoped fields (for IAM role + container build)
 * plus the full validated spec + its config directory so the L3 construct can
 * synthesize the AWS::BedrockAgentCore::Harness resource.
 */
export type HarnessConfig = HarnessDeploymentConfig;

export interface ManualPaymentConnectorSpec {
  name: string;
  provider: 'CoinbaseCDP' | 'StripePrivy';
  provisionMode?: 'MANUAL';
  credentialName: string;
  credentialProviderArn: string;
}

export interface QuickCreatePaymentConnectorSpec {
  name: string;
  provider: 'CoinbaseCDP';
  provisionMode: 'QUICK_CREATE';
  credentialName?: never;
  credentialProviderArn?: never;
}

export type PaymentConnectorSpec = ManualPaymentConnectorSpec | QuickCreatePaymentConnectorSpec;

export interface PaymentSpec {
  name: string;
  description?: string;
  authorizerType: 'AWS_IAM' | 'CUSTOM_JWT';
  authorizerConfiguration?: { customJWTAuthorizer: CustomJWTAuthorizerConfig };
  autoPayment?: boolean;
  paymentToolAllowlist?: string[];
  networkPreferences?: string[];
  connectors: PaymentConnectorSpec[];
}

export interface AgentCoreStackProps extends StackProps {
  /**
   * The AgentCore project specification containing agents, memories, and credentials.
   */
  spec: AgentCoreProjectSpec;
  /**
   * The MCP specification containing gateways and servers.
   */
  mcpSpec?: AgentCoreMcpSpec;
  /**
   * Credential provider ARNs from deployed state, keyed by credential name.
   */
  credentials?: Record<string, { credentialProviderArn: string; clientSecretArn?: string }>;
  /**
   * Harness role configurations.
   */
  harnesses?: HarnessConfig[];
  /**
   * Parsed connectorParameters for non-S3 KB data sources, keyed by
   * connectorConfigFile path. Forwarded to AgentCoreApplication.
   */
  connectorParametersByFile?: Record<string, Record<string, unknown>>;
  /**
   * Payment specifications with resolved credential provider ARNs.
   */
  paymentSpec?: PaymentSpec[];
  /**
   * Absolute path to the project root (parent of the agentcore/ directory).
   * Used to resolve local Lambda asset directories such as tools/.
   */
  projectRoot?: string;
}

function toCdkId(name: string): string {
  return name.replace(/_/g, '');
}

/**
 * Decide whether a deployed runtime should receive payment env vars + IAM grants.
 * Payments today only ships a runtime shim for Python HTTP runtimes; injecting
 * AGENTCORE_PAYMENT_* env vars into TypeScript / MCP / A2A / AGUI runtimes
 * would surface env vars they cannot consume and would dilute least-privilege
 * IAM grants for runtimes that never call ProcessPayment.
 */
function isPaymentEligibleAgent(agent: { entrypoint?: string; protocol?: string }): boolean {
  if (agent.protocol && agent.protocol !== 'HTTP') {
    return false;
  }
  const entrypoint = typeof agent.entrypoint === 'string' ? agent.entrypoint : '';
  const entrypointFile = entrypoint.split(':')[0] ?? '';
  return entrypointFile.endsWith('.py');
}

/**
 * CDK Stack that deploys AgentCore infrastructure.
 *
 * This is a thin wrapper that instantiates L3 constructs.
 * All resource logic and outputs are contained within the L3 constructs.
 */
export class AgentCoreStack extends Stack {
  /** The AgentCore application containing all agent environments */
  public readonly application: AgentCoreApplication;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    const { spec, mcpSpec, credentials, harnesses, connectorParametersByFile, paymentSpec, projectRoot } = props;

    // Create AgentCoreApplication with all agents and harness roles
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appProps: Record<string, unknown> = { spec };
    if (harnesses?.length) {
      appProps.harnesses = harnesses;
    }
    if (connectorParametersByFile && Object.keys(connectorParametersByFile).length > 0) {
      appProps.connectorParametersByFile = connectorParametersByFile;
    }
    if (credentials) {
      appProps.credentials = credentials;
    }
    this.application = new AgentCoreApplication(this, 'Application', appProps as any);

    // Grant the deployed Gemini credential explicitly because the published L3
    // construct currently drops the CLI schema's credential fields.
    for (const env of this.application.environments.values()) {
      env.runtime.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['bedrock-agentcore:GetResourceApiKey'],
          resources: [`arn:${this.partition}:bedrock-agentcore:*:${this.account}:token-vault/default/apikeycredentialprovider/GEMINI`],
        })
      );
      // Allow the agent runtime to invoke the MCP gateway (SigV4), scoped to
      // gateways in this account/region for least privilege.
      env.runtime.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['bedrock-agentcore:InvokeGateway'],
          resources: [`arn:${this.partition}:bedrock-agentcore:*:${this.account}:gateway/*`],
        })
      );
    }

    // --- Business-tool infrastructure (order / customer / refund) ---
    // DynamoDB-backed idempotency store so a retried refund never double-charges.
    const refundIdempotencyTable = new dynamodb.Table(this, 'RefundIdempotency', {
      tableName: 'CustomerSupportAgent-RefundIdempotency',
      partitionKey: { name: 'idempotency_key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const toolsRoot = path.join(projectRoot ?? path.resolve(process.cwd(), '..', '..'), 'tools');
    const makeToolFn = (id: string, functionName: string, dir: string, timeout: Duration) =>
      new lambda.Function(this, id, {
        functionName,
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'handler.handler',
        code: lambda.Code.fromAsset(path.join(toolsRoot, dir)),
        timeout,
      });

    // check_order has a short timeout so the ORD-TIMEOUT trigger produces a tool-timeout trace.
    const checkOrderFn = makeToolFn('CheckOrderFn', 'CustomerSupportAgent-CheckOrder', 'check_order', Duration.seconds(10));
    const getCustomerFn = makeToolFn('GetCustomerFn', 'CustomerSupportAgent-GetCustomer', 'get_customer', Duration.seconds(30));
    const processRefundFn = makeToolFn('ProcessRefundFn', 'CustomerSupportAgent-ProcessRefund', 'process_refund', Duration.seconds(30));

    // Least privilege: only the refund tool can read/write the idempotency table.
    refundIdempotencyTable.grantReadWriteData(processRefundFn);
    processRefundFn.addEnvironment('IDEMPOTENCY_TABLE', refundIdempotencyTable.tableName);

    // Create AgentCoreMcp if there are gateways configured
    if (mcpSpec?.agentCoreGateways && mcpSpec.agentCoreGateways.length > 0) {
      const mcp = new AgentCoreMcp(this, 'Mcp', {
        projectName: spec.name,
        mcpSpec,
        agentCoreApplication: this.application,
        credentials,
        projectTags: spec.tags,
      });
      // Ensure the tool Lambdas exist before the gateway wires targets to their ARNs.
      mcp.node.addDependency(checkOrderFn, getCustomerFn, processRefundFn);

      for (const gatewaySpec of mcpSpec.agentCoreGateways) {
        const policyEngineName = gatewaySpec.policyEngineConfiguration?.policyEngineName;
        if (!policyEngineName) {
          continue;
        }

        const gateway = mcp.gateways.get(gatewaySpec.name);
        const policyEngine = this.application.policyEngines.get(policyEngineName);
        if (!gateway || !policyEngine) {
          continue;
        }

        const policyEngineResource = policyEngine.node
          .findAll()
          .find((child): child is bedrockagentcore.CfnPolicyEngine => child instanceof bedrockagentcore.CfnPolicyEngine);
        gateway.node.scope?.node.removeDependency(policyEngine);
        if (policyEngineResource) {
          gateway.addDependency(policyEngineResource);
        }

        for (const child of policyEngine.node.findAll()) {
          if (!(child instanceof bedrockagentcore.CfnPolicy)) {
            continue;
          }
          const policySpec = spec.policyEngines
            .find((engine) => engine.name === policyEngineName)
            ?.policies.find((policy) => child.node.id === `Policy${policy.name}`);
          if (!policySpec) {
            continue;
          }

          const statement = policySpec.statement.replace(
            'resource is AgentCore::Gateway',
            `resource == AgentCore::Gateway::"${gateway.attrGatewayArn}"`
          );
          child.addPropertyOverride('Definition.Policy.Statement', statement);
          child.addDependency(gateway);
          for (const target of mcp.node.findAll()) {
            if (target instanceof bedrockagentcore.CfnGatewayTarget) {
              child.addDependency(target);
            }
          }
        }
      }
    }

    // Create payment infrastructure via CFN constructs
    if (paymentSpec && paymentSpec.length > 0) {
      for (const payment of paymentSpec) {
        const mgrId = toCdkId(payment.name);
        const manager = new AgentCorePaymentManager(this, `Payment${mgrId}`, {
          projectName: spec.name,
          name: payment.name,
          authorizerType: payment.authorizerType,
          description: payment.description,
          authorizerConfiguration: payment.authorizerConfiguration,
          tags: spec.tags,
        });

        const prefix = `AGENTCORE_PAYMENT_${payment.name.toUpperCase().replace(/-/g, '_')}`;

        // Wire env vars from construct output tokens into eligible agent environments only.
        // See isPaymentEligibleAgent — non-Python or non-HTTP runtimes have no shim that
        // can consume these env vars, and giving them sts:AssumeRole on the
        // ProcessPaymentRole would broaden the privilege surface unnecessarily.
        for (const env of this.application.environments.values()) {
          if (!isPaymentEligibleAgent(env.agent)) {
            continue;
          }
          env.runtime.addEnvironmentVariable(`${prefix}_MANAGER_ARN`, manager.paymentManagerArn);
          env.runtime.addEnvironmentVariable(`${prefix}_PROCESS_PAYMENT_ROLE_ARN`, manager.processPaymentRoleArn);

          // Grant runtime execution role permission to assume the ProcessPaymentRole.
          // The ProcessPaymentRole's trust policy allows AccountRootPrincipal, but the
          // caller still needs sts:AssumeRole on its own role to perform the assumption.
          env.runtime.role.addToPrincipalPolicy(
            new iam.PolicyStatement({
              actions: ['sts:AssumeRole'],
              resources: [manager.processPaymentRoleArn],
            })
          );

          // Grant payment data-plane actions directly to the runtime role.
          //
          // NOTE: This deviates from the canonical role model in the AgentCore Payments
          // beta guide, which assigns Get/List/Create instrument+session actions to a
          // separate ManagementRole and limits the agent's role to ProcessPayment only.
          // The current SDK plugin (AgentCorePaymentsPlugin.generate_payment_header)
          // calls GetPaymentInstrument internally during the 402 auto-pay path, so the
          // runtime role needs read access. CreatePaymentSession is included so
          // `agentcore invoke --auto-session` works without a separate ManagementRole
          // call. Tighten this if the SDK is updated to accept pre-fetched instrument
          // details and split create-session into a backend-only flow.
          env.runtime.role.addToPrincipalPolicy(
            new iam.PolicyStatement({
              actions: [
                'bedrock-agentcore:GetPaymentInstrument',
                'bedrock-agentcore:ListPaymentInstruments',
                'bedrock-agentcore:GetPaymentInstrumentBalance',
                'bedrock-agentcore:GetPaymentSession',
                'bedrock-agentcore:ListPaymentSessions',
                'bedrock-agentcore:CreatePaymentSession',
                'bedrock-agentcore:ProcessPayment',
              ],
              resources: [manager.paymentManagerArn, `${manager.paymentManagerArn}/*`],
            })
          );

          if (payment.autoPayment !== undefined) {
            env.runtime.addEnvironmentVariable(`${prefix}_AUTO_PAYMENT`, String(payment.autoPayment));
          }
          if (payment.paymentToolAllowlist) {
            env.runtime.addEnvironmentVariable(`${prefix}_TOOL_ALLOWLIST`, payment.paymentToolAllowlist.join(','));
          }
          if (payment.networkPreferences) {
            env.runtime.addEnvironmentVariable(`${prefix}_NETWORK_PREFERENCES`, payment.networkPreferences.join(','));
          }
          if (payment.authorizerType === 'CUSTOM_JWT') {
            env.runtime.addEnvironmentVariable(`${prefix}_AUTH_MODE`, 'bearer');
          }
        }

        // Create connectors for this manager
        for (const connector of payment.connectors) {
          const connId = toCdkId(connector.name);
          const schemaConnector =
            connector.provisionMode === 'QUICK_CREATE'
              ? connector
              : {
                name: connector.name,
                provider: connector.provider,
                ...(connector.provisionMode && { provisionMode: connector.provisionMode }),
                credentialName: connector.credentialName,
              };
          const compatibilityProps = {
            projectName: spec.name,
            paymentManager: manager,
            connector: schemaConnector,
            // Remove these legacy manual fields after the new L3 release is pinned.
            connectorName: connector.name,
            connectorType: connector.provider,
            ...(connector.provisionMode !== 'QUICK_CREATE' && {
              credentialProviderArn: connector.credentialProviderArn,
            }),
          };
          const conn = new AgentCorePaymentConnector(
            this,
            `Payment${mgrId}${connId}`,
            compatibilityProps as unknown as ConstructorParameters<typeof AgentCorePaymentConnector>[2]
          );

          // Wire first connector's ID as env var (eligible agents only)
          if (connector === payment.connectors[0]) {
            for (const env of this.application.environments.values()) {
              if (!isPaymentEligibleAgent(env.agent)) continue;
              env.runtime.addEnvironmentVariable(`${prefix}_CONNECTOR_ID`, conn.paymentConnectorId);
            }
          }

          new CfnOutput(this, `Payment${mgrId}${connId}ConnectorId`, {
            value: conn.paymentConnectorId,
          });
          if (connector.provisionMode === 'QUICK_CREATE') {
            const quickCreateConnector = conn as AgentCorePaymentConnector & {
              paymentConnectorStatus: string;
              authorizationUrl: string;
            };
            new CfnOutput(this, `Payment${mgrId}${connId}ConnectorStatus`, {
              value: quickCreateConnector.paymentConnectorStatus,
            });
            new CfnOutput(this, `Payment${mgrId}${connId}AuthorizationUrl`, {
              value: quickCreateConnector.authorizationUrl,
            });
          }
        }

        // CFN Outputs for post-deploy state parsing
        new CfnOutput(this, `Payment${mgrId}ManagerArn`, {
          value: manager.paymentManagerArn,
        });
        new CfnOutput(this, `Payment${mgrId}ManagerId`, {
          value: manager.paymentManagerId,
        });
        new CfnOutput(this, `Payment${mgrId}ProcessPaymentRoleArn`, {
          value: manager.processPaymentRoleArn,
        });
        new CfnOutput(this, `Payment${mgrId}ResourceRetrievalRoleArn`, {
          value: manager.resourceRetrievalRoleArn,
        });
      }
    }

    // Stack-level output
    new CfnOutput(this, 'StackNameOutput', {
      description: 'Name of the CloudFormation Stack',
      value: this.stackName,
    });
  }
}
