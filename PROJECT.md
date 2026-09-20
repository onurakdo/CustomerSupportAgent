
# CustomerSupportAgent

this file is for final project sumbission explaiantion, 
and the readme.md file inside customer support is created by agentcore, and stores agent archutecxture items, (name can be cahnged after)

1.
cloud formation is created and it is checked using below command, cloud formation setup is created by using the link inside the below lab link. 
https://catalog.us-east-1.prod.workshops.aws/workshops/c770f35f-90a9-4e02-8985-4ef912bddb77/en-US/10-prereqs/12-self-paced
Note that, the stack creates additoanl lambda services and other recpurces, they will be irrelavant, but to keep it simple I directly use the cloudformation stack.


aws cloudformation describe-stacks \
  --stack-name agentcore-customer-support-agent\
  --query 'Stacks[0].StackStatus' --output text


2.
project is initialized using below command
agentcore create \
  --name CustomerSupportAgent \
  --framework Strands \
  --model-provider Gemini \
  --memory none

3.
