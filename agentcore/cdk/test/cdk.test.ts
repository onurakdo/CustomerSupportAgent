import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ConfigIO } from '@aws/agentcore-cdk';
import * as path from 'path';
import { AgentCoreStack } from '../lib/cdk-stack';

test('AgentCoreStack synthesizes with empty spec', () => {
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'TestStack', {
    spec: {
      name: 'testproject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      configBundles: [],
      policyEngines: [],
      payments: [],
      agentCoreGateways: [],
      mcpRuntimeTools: [],
      unassignedTargets: [],
      datasets: [],
      knowledgeBases: [],
    },
  });
  const template = Template.fromStack(stack);
  template.hasOutput('StackNameOutput', {
    Description: 'Name of the CloudFormation Stack',
  });
});

test('tool policies are scoped to the concrete gateway ARN', async () => {
  const configRoot = path.resolve(__dirname, '..', '..');
  const spec = await new ConfigIO({ baseDir: configRoot }).readProjectSpec();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const specAny = spec as any;
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'PolicyTestStack', {
    spec,
    mcpSpec: {
      agentCoreGateways: specAny.agentCoreGateways,
      mcpRuntimeTools: specAny.mcpRuntimeTools,
    },
    projectRoot: path.resolve(configRoot, '..'),
  });

  const policies = Template.fromStack(stack).findResources('AWS::BedrockAgentCore::Policy');
  expect(Object.keys(policies)).toHaveLength(4);
  for (const policy of Object.values(policies)) {
    const statement = JSON.stringify(policy.Properties.Definition.Policy.Statement);
    expect(statement).toContain('resource == AgentCore::Gateway::');
    expect(statement).toContain('GatewayArn');
    expect(statement).not.toContain('resource is AgentCore::Gateway');
    expect(policy.DependsOn).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^McpGatewayCustomerSupportGwTargetCheckOrder/),
        expect.stringMatching(/^McpGatewayCustomerSupportGwTargetGetCustomer/),
        expect.stringMatching(/^McpGatewayCustomerSupportGwTargetProcessRefund/),
      ])
    );
  }
});
