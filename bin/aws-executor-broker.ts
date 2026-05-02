#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { AwsExecutorBrokerStack } from "../lib/aws-executor-broker-stack";

const app = new cdk.App();
new AwsExecutorBrokerStack(app, process.env.STACK_NAME!, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
