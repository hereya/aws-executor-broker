import * as cdk from "aws-cdk-lib/core";
import { Template, Match } from "aws-cdk-lib/assertions";
import { AwsExecutorBrokerStack } from "../lib/aws-executor-broker-stack";

function synthesise(): Template {
  process.env.workspaceId = "ws-test";
  process.env.workspaceName = "test";
  process.env.hereyaCloudUrl = "https://cloud.hereya.dev";
  process.env.brokerConcurrency = "5";
  process.env.ec2InstanceType = "t3.small";
  process.env.idleTimeoutSeconds = "300";

  const app = new cdk.App();
  const stack = new AwsExecutorBrokerStack(app, "TestExecBrokerStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

describe("AwsExecutorBrokerStack", () => {
  it("provisions the broker Lambda with reserved concurrency and Function URL (AWS_IAM)", () => {
    const t = synthesise();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Timeout: 25,
      MemorySize: 512,
      ReservedConcurrentExecutions: 5,
      Environment: {
        Variables: Match.objectLike({
          HEREYA_CLOUD_URL: "https://cloud.hereya.dev",
          WORKSPACE_ID: "ws-test",
          WORKSPACE_NAME: "test",
          EXPECTED_BROKER_AUD: "broker:ws-test",
        }),
      },
    });
    t.hasResourceProperties("AWS::Lambda::Url", {
      AuthType: "AWS_IAM",
    });
  });

  it("provisions both DynamoDB tables with TTL configured", () => {
    const t = synthesise();
    t.resourceCountIs("AWS::DynamoDB::Table", 2);
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "jti", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "workspaceId", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  it("provisions an OIDC identity provider for hereya-cloud", () => {
    const t = synthesise();
    t.hasResourceProperties(
      "Custom::AWSCDKOpenIdConnectProvider",
      Match.objectLike({
        ClientIDList: ["sts.amazonaws.com"],
        Url: "https://cloud.hereya.dev",
      })
    );
  });

  it("provisions the invoker role with sub/aud/ExternalId conditions", () => {
    const t = synthesise();
    t.hasResourceProperties(
      "AWS::IAM::Role",
      Match.objectLike({
        RoleName: "HereyaBrokerInvoker-ws-test",
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "sts:AssumeRoleWithWebIdentity",
              Condition: Match.objectLike({
                StringEquals: Match.objectLike({
                  "cloud.hereya.dev:sub": "workspace:ws-test",
                  "cloud.hereya.dev:aud": "sts.amazonaws.com",
                }),
                StringLike: Match.objectLike({
                  "sts:ExternalId": "ws-test",
                }),
              }),
            }),
          ]),
        }),
      })
    );
  });

  it("provisions an EC2 launch template with IMDSv2 + shutdown=stop", () => {
    const t = synthesise();
    t.hasResourceProperties(
      "AWS::EC2::LaunchTemplate",
      Match.objectLike({
        LaunchTemplateData: Match.objectLike({
          InstanceInitiatedShutdownBehavior: "stop",
          MetadataOptions: Match.objectLike({
            HttpTokens: "required",
          }),
        }),
      })
    );
  });

  it("emits all the install-time outputs", () => {
    const t = synthesise();
    t.hasOutput("brokerWebhookUrl", {});
    t.hasOutput("brokerVersion", {});
    t.hasOutput("awsAccountId", {});
    t.hasOutput("region", {});
    t.hasOutput("ec2LaunchTemplateId", {});
    t.hasOutput("ec2InstanceId", {});
    t.hasOutput("invokerRoleArn", {});
    t.hasOutput("brokerLambdaArn", {});
  });
});
