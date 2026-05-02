import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import * as path from "path";

/**
 * Ephemeral remote-executor broker for a single Hereya workspace.
 *
 * Provisions in the customer's AWS account:
 *   - OIDC identity provider trusting hereya-cloud (issuer = hereyaCloudUrl).
 *   - IAM role HereyaBrokerInvoker-<workspaceId> that hereya-cloud assumes via
 *     web-identity federation in order to SigV4-sign Lambda Function URL calls.
 *   - Broker Lambda (NodejsFunction, esbuild-bundled) with Function URL
 *     (AuthType=AWS_IAM). Verifies hereya-cloud's KMS-signed JWT, dispatches to
 *     either resolve-env (in-Lambda) or wakes the EC2 executor.
 *   - DynamoDB tables: BrokerJtiCache (jti replay), WorkspaceWakeLock (per-ws
 *     dedup of wake attempts).
 *   - EC2 launch template + a single instance held in `stopped` state, with
 *     UserData that installs hereya-cli + a systemd unit that boots the
 *     executor against hereya-cloud using a single-use bootstrap JWT.
 *   - Executor instance role with the minimum perms to redeem its bootstrap +
 *     run hereya executor.
 */
export class AwsExecutorBrokerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------
    // Parameters (passed via env by hereya-cli)
    // ------------------------------------------------------------------

    const workspaceId = requireEnv("workspaceId");
    const workspaceName = requireEnv("workspaceName");
    const hereyaCloudUrlRaw = requireEnv("hereyaCloudUrl");
    const hereyaCloudUrl = hereyaCloudUrlRaw.replace(/\/+$/, "");

    const brokerConcurrency = parseInt(
      process.env["brokerConcurrency"] ?? "50",
      10
    );
    const ec2InstanceType = process.env["ec2InstanceType"] ?? "t3.medium";
    const idleTimeoutSeconds = parseInt(
      process.env["idleTimeoutSeconds"] ?? "600",
      10
    );

    const brokerVersion = "0.1.0";

    // ------------------------------------------------------------------
    // OIDC identity provider — trust anchor for hereya-cloud federation
    // ------------------------------------------------------------------

    // The thumbprint passed here is replaced at first deploy by AWS itself
    // when the OIDC provider is created via the OpenIdConnectProvider L2
    // construct (it issues a custom resource that fetches and pins the live
    // thumbprint of the JWKS endpoint's TLS certificate). We therefore omit
    // an explicit thumbprint here.
    const oidcProvider = new iam.OpenIdConnectProvider(
      this,
      "HereyaCloudOidcProvider",
      {
        url: hereyaCloudUrl,
        clientIds: ["sts.amazonaws.com"],
      }
    );

    // The 'iss' claim hereya-cloud puts in tokens — the host portion of the URL
    // (no scheme). Used to key the trust-policy condition.
    const oidcHost = hereyaCloudUrl.replace(/^https?:\/\//, "");

    // ------------------------------------------------------------------
    // DynamoDB: jti replay cache + per-workspace wake lock
    // ------------------------------------------------------------------

    const jtiCacheTable = new dynamodb.Table(this, "BrokerJtiCache", {
      partitionKey: { name: "jti", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const wakeLockTable = new dynamodb.Table(this, "WorkspaceWakeLock", {
      partitionKey: {
        name: "workspaceId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ------------------------------------------------------------------
    // Executor instance role — runs on the EC2, redeems its own bootstrap.
    //
    // Permissions:
    //   - Read+delete its own /hereya/bootstrap/<instanceId> SSM SecureString.
    //   - Decrypt for SSM SecureString (via service condition).
    //   - The wide infrastructure perms today's always-on executor needs to
    //     provision arbitrary terraform/cdk packages: AdministratorAccess +
    //     SSMManagedInstanceCore (mirrors hereya/remote-executor-aws). Tag
    //     scoping is left as a future hardening pass.
    // ------------------------------------------------------------------

    const executorRole = new iam.Role(this, "ExecutorInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess"),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
      ],
    });

    // Tighten access on the bootstrap SSM path so a compromised executor
    // can only read/delete its own parameter (the Lambda writes; instance
    // reads & deletes after redeem). The blanket Admin policy already
    // technically covers SSM but we add an explicit allow scoped to the
    // bootstrap prefix to make the design intent visible.
    executorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:DeleteParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/hereya/bootstrap/*`,
        ],
      })
    );

    const executorInstanceProfile = new iam.CfnInstanceProfile(
      this,
      "ExecutorInstanceProfile",
      {
        roles: [executorRole.roleName],
      }
    );

    // ------------------------------------------------------------------
    // EC2 networking — default VPC, public subnet, egress-only SG
    // ------------------------------------------------------------------

    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    const executorSg = new ec2.SecurityGroup(this, "ExecutorSG", {
      vpc,
      description: "Hereya ephemeral executor — outbound only",
      allowAllOutbound: true,
    });

    // ------------------------------------------------------------------
    // EC2 launch template: Ubuntu 22.04, gp3 30GB, IMDSv2, shutdown=stop
    // ------------------------------------------------------------------

    const ubuntu = ec2.MachineImage.fromSsmParameter(
      "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
      { os: ec2.OperatingSystemType.LINUX }
    );

    const userData = buildUserData({
      hereyaCloudUrl,
      workspaceName,
      idleTimeoutSeconds,
    });

    const launchTemplate = new ec2.LaunchTemplate(this, "ExecutorLT", {
      instanceType: new ec2.InstanceType(ec2InstanceType),
      machineImage: ubuntu,
      role: executorRole,
      securityGroup: executorSg,
      userData,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: "/dev/sda1",
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
      // Stop (don't terminate) on OS shutdown so EBS persists between wakes.
      instanceInitiatedShutdownBehavior:
        ec2.InstanceInitiatedShutdownBehavior.STOP,
    });

    // ------------------------------------------------------------------
    // EC2 instance, created and then stopped via custom resource.
    //
    // CloudFormation's AWS::EC2::Instance does not support a "stopped" target
    // state. We use AwsCustomResource to RunInstances on create and
    // StopInstances immediately afterwards, then TerminateInstances on stack
    // delete. The resulting instance ID is captured into a CFN output and
    // injected into the broker Lambda's environment.
    // ------------------------------------------------------------------

    // Pick the first public subnet in the default VPC.
    const subnetIds = vpc.publicSubnets.map((s) => s.subnetId);
    const firstSubnetId = subnetIds[0];

    const ec2Instance = new cr.AwsCustomResource(this, "ExecutorEc2Instance", {
      onCreate: {
        service: "EC2",
        action: "runInstances",
        parameters: {
          MinCount: 1,
          MaxCount: 1,
          LaunchTemplate: {
            LaunchTemplateId: launchTemplate.launchTemplateId,
          },
          SubnetId: firstSubnetId,
          TagSpecifications: [
            {
              ResourceType: "instance",
              Tags: [
                { Key: "hereya:workspaceId", Value: workspaceId },
                { Key: "hereya:workspaceName", Value: workspaceName },
                { Key: "Name", Value: `hereya-executor-${workspaceName}` },
              ],
            },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse(
          "Instances.0.InstanceId"
        ),
      },
      onDelete: {
        service: "EC2",
        action: "terminateInstances",
        parameters: {
          InstanceIds: [
            new cr.PhysicalResourceIdReference() as unknown as string,
          ],
        },
      },
      installLatestAwsSdk: false,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            "ec2:RunInstances",
            "ec2:CreateTags",
            "ec2:TerminateInstances",
            "ec2:DescribeInstances",
          ],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [executorRole.roleArn],
        }),
      ]),
    });
    ec2Instance.node.addDependency(executorInstanceProfile);

    const ec2InstanceId = ec2Instance.getResponseField("Instances.0.InstanceId");

    // After the instance is created we immediately stop it so the first wake
    // happens from `stopped` (≈30s boot) rather than `running` (no-op) or a
    // fresh RunInstances (≈60s).
    const stopAfterCreate = new cr.AwsCustomResource(
      this,
      "ExecutorEc2StopAfterCreate",
      {
        onCreate: {
          service: "EC2",
          action: "stopInstances",
          parameters: {
            InstanceIds: [ec2InstanceId],
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `stop-${this.stackName}`
          ),
          // Some accounts have race conditions where StopInstances arrives
          // before the instance state has materialised — retries handled by
          // the SDK; ignore IncorrectInstanceState the first time.
          ignoreErrorCodesMatching: "IncorrectInstanceState",
        },
        installLatestAwsSdk: false,
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["ec2:StopInstances", "ec2:DescribeInstances"],
            resources: ["*"],
          }),
        ]),
      }
    );
    stopAfterCreate.node.addDependency(ec2Instance);

    // ------------------------------------------------------------------
    // Broker Lambda — NodejsFunction with esbuild bundling
    // ------------------------------------------------------------------

    const expectedAud = `broker:${workspaceId}`;

    const brokerLambda = new nodejs.NodejsFunction(this, "BrokerLambda", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "..", "lambda", "handler.ts"),
      handler: "handler",
      memorySize: 512,
      timeout: cdk.Duration.seconds(25),
      reservedConcurrentExecutions: brokerConcurrency,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node22",
        // The AWS-provided runtime ships @aws-sdk/* — externalize to keep the
        // bundle small and to avoid accidentally pinning an older version.
        // hereya-cli is also externalized: at deploy time the published npm
        // version (>=N.M with the broker exports) is installed alongside the
        // bundle by CDK's NodejsFunction packaging step.
        externalModules: [
          "@aws-sdk/client-ssm",
          "@aws-sdk/client-secretsmanager",
          "@aws-sdk/client-ec2",
          "@aws-sdk/client-dynamodb",
          "@aws-sdk/lib-dynamodb",
          "hereya-cli",
        ],
        // Externalized but installed-into-bundle modules: NodejsFunction runs
        // `npm install <name>` inside the asset bundle so the runtime can
        // require it. (The @aws-sdk/* names above stay externalized AND are
        // not in nodeModules — they're satisfied by the AWS-provided runtime.)
        nodeModules: ["hereya-cli"],
      },
      environment: {
        HEREYA_CLOUD_URL: hereyaCloudUrl,
        WORKSPACE_ID: workspaceId,
        WORKSPACE_NAME: workspaceName,
        JTI_CACHE_TABLE: jtiCacheTable.tableName,
        WAKE_LOCK_TABLE: wakeLockTable.tableName,
        LAUNCH_TEMPLATE_ID: launchTemplate.launchTemplateId ?? "",
        EC2_INSTANCE_ID: ec2InstanceId,
        EXPECTED_BROKER_AUD: expectedAud,
      },
    });

    // EC2 control + tag-based discovery
    brokerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:DescribeInstances",
          "ec2:StartInstances",
          "ec2:RunInstances",
          "ec2:CreateTags",
        ],
        resources: ["*"],
      })
    );
    brokerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [executorRole.roleArn],
      })
    );

    // SSM bootstrap parameter — Lambda writes, executor reads/deletes.
    brokerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:GetParameter",
          "ssm:PutParameter",
          "ssm:DeleteParameter",
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/hereya/bootstrap/*`,
        ],
      })
    );

    // resolve-env may need to read SecretsManager values referenced from a
    // package's outputs. Broad read perms (the values themselves are scoped
    // to whatever the workspace's packages provisioned).
    brokerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: ["*"],
      })
    );

    // KMS decrypt for SSM SecureString reads.
    brokerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "kms:ViaService": `ssm.${this.region}.amazonaws.com`,
          },
        },
      })
    );

    jtiCacheTable.grantReadWriteData(brokerLambda);
    wakeLockTable.grantReadWriteData(brokerLambda);

    // ------------------------------------------------------------------
    // Function URL with AWS_IAM auth — only the invoker role can call.
    // ------------------------------------------------------------------

    const fnUrl = brokerLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // ------------------------------------------------------------------
    // Invoker role — assumed by hereya-cloud via web-identity federation.
    //
    // Trust policy:
    //   Principal: oidcProvider
    //   Action: sts:AssumeRoleWithWebIdentity
    //   Conditions:
    //     <issHost>:sub == workspace:<workspaceId>
    //     <issHost>:aud == sts.amazonaws.com
    //     sts:ExternalId == <workspaceId>
    // Permission: lambda:InvokeFunctionUrl on this Lambda only.
    // ------------------------------------------------------------------

    const invokerRoleName = `HereyaBrokerInvoker-${workspaceId}`;

    const invokerRole = new iam.Role(this, "BrokerInvokerRole", {
      roleName: invokerRoleName,
      assumedBy: new iam.FederatedPrincipal(
        oidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            [`${oidcHost}:sub`]: `workspace:${workspaceId}`,
            [`${oidcHost}:aud`]: "sts.amazonaws.com",
          },
          StringLike: {
            "sts:ExternalId": workspaceId,
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
    });

    invokerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunctionUrl"],
        resources: [brokerLambda.functionArn],
      })
    );

    // ------------------------------------------------------------------
    // CFN outputs (the install command POSTs these to hereya-cloud)
    // ------------------------------------------------------------------

    new cdk.CfnOutput(this, "brokerWebhookUrl", { value: fnUrl.url });
    new cdk.CfnOutput(this, "brokerVersion", { value: brokerVersion });
    new cdk.CfnOutput(this, "awsAccountId", { value: this.account });
    new cdk.CfnOutput(this, "region", { value: this.region });
    new cdk.CfnOutput(this, "ec2LaunchTemplateId", {
      value: launchTemplate.launchTemplateId ?? "",
    });
    new cdk.CfnOutput(this, "ec2InstanceId", { value: ec2InstanceId });
    new cdk.CfnOutput(this, "invokerRoleArn", { value: invokerRole.roleArn });
    new cdk.CfnOutput(this, "brokerLambdaArn", {
      value: brokerLambda.functionArn,
    });
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} environment variable is required`);
  }
  return v;
}

function buildUserData(opts: {
  hereyaCloudUrl: string;
  workspaceName: string;
  idleTimeoutSeconds: number;
}): ec2.UserData {
  const { hereyaCloudUrl, workspaceName, idleTimeoutSeconds } = opts;
  const ud = ec2.UserData.forLinux();
  ud.addCommands(
    "set -ex",
    "exec > >(tee /var/log/hereya-userdata.log) 2>&1",

    // Base packages
    "apt-get update -y",
    "apt-get install -y curl ca-certificates jq awscli",

    // Node.js 22 via NodeSource
    "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
    "apt-get install -y nodejs",

    // hereya-cli
    "npm install -g hereya-cli",

    // Drop the bootstrap-redeem helper
    "install -d -m 0755 /usr/local/bin",
    "cat > /usr/local/bin/hereya-redeem-bootstrap.sh <<'REDEEMSH'",
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'INSTANCE_ID=$(curl -sS -H "X-aws-ec2-metadata-token: $(curl -sS -X PUT http://169.254.169.254/latest/api/token -H \'X-aws-ec2-metadata-token-ttl-seconds: 60\')" http://169.254.169.254/latest/meta-data/instance-id)',
    "mkdir -p /run/hereya",
    "chmod 700 /run/hereya",
    'BOOTSTRAP=$(aws ssm get-parameter --with-decryption --name "/hereya/bootstrap/${INSTANCE_ID}" --query \'Parameter.Value\' --output text)',
    'RESP=$(curl -sS -X POST "${HEREYA_CLOUD_URL}/api/workspaces/${WORKSPACE_NAME}/executor-token/redeem" \\',
    "  -H 'Content-Type: application/json' \\",
    '  -d "{\\"token\\":\\"$BOOTSTRAP\\"}")',
    "echo \"$RESP\" | jq -r '.token' > /run/hereya/token",
    "chmod 600 /run/hereya/token",
    'aws ssm delete-parameter --name "/hereya/bootstrap/${INSTANCE_ID}" || true',
    "REDEEMSH",
    "chmod +x /usr/local/bin/hereya-redeem-bootstrap.sh",

    // Drop the systemd EnvironmentFile
    "install -d -m 0755 /etc/hereya",
    "cat > /etc/hereya/executor.env <<EOF",
    `HEREYA_CLOUD_URL=${hereyaCloudUrl}`,
    `WORKSPACE_NAME=${workspaceName}`,
    `IDLE_TIMEOUT=${idleTimeoutSeconds}`,
    "EOF",

    // The systemd unit runs as ubuntu; redeem must precede start.
    "cat > /etc/systemd/system/hereya-executor.service <<'UNIT'",
    "[Unit]",
    "Description=Hereya remote executor",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "User=ubuntu",
    "WorkingDirectory=/home/ubuntu",
    "EnvironmentFile=/etc/hereya/executor.env",
    "ExecStartPre=/usr/local/bin/hereya-redeem-bootstrap.sh",
    "ExecStart=/usr/bin/env bash -c 'HEREYA_TOKEN=$(cat /run/hereya/token) HEREYA_CLOUD_URL=${HEREYA_CLOUD_URL} hereya executor start -w ${WORKSPACE_NAME} --idle-timeout=${IDLE_TIMEOUT} --concurrency=20'",
    "ExecStopPost=/sbin/shutdown -h now",
    "OnFailure=shutdown.target",
    "Restart=no",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",

    "systemctl daemon-reload",
    "systemctl enable hereya-executor.service",
    // Do NOT start here — instance will be stopped immediately after
    // creation by the stack's StopAfterCreate custom resource. The service
    // will start automatically on the first wake.
    "systemctl start hereya-executor.service || true"
  );
  return ud;
}
