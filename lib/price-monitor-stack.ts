import * as path from "path";
import { Construct } from "constructs";
import {
  aws_events as events,
  aws_events_targets as targets,
  aws_lambda_nodejs as lambdaNodejs,
  aws_lambda as lambda,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda_event_sources as awsLambdaEventSources,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_sns as sns,
  aws_sns_subscriptions as snsSubscriptions,
  aws_ssm as ssm,
  Stack,
  StackProps,
  Duration,
} from "aws-cdk-lib";

const RESOURCE_ID = {
  DYNAMODB_TABLE_PRICES: "DynamoDbTablePrices",
  SSM_PARAMETER_EMAIL_ALERTS: "SsmParameterEmailAlerts",
  SNS_TOPIC_ALERTS: "SnsTopicAlerts",
  LAMBDA_PRICE_CHECK: "LambdaPriceCheck",
  LAMBDA_NOTOFICATION: "LambdaNotification",
  LAMBDA_PRICE_CHECK_ALARM: "LambdaPriceCheckAlarm",
  LAMBDA_NOTOFICATION_ALARM: "LambdaNotificationAlarm",
  SCHEDULED_EVENT: "ScheduledEvent",
};

export class PriceMonitorStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const dynamoDbTablePrices = new dynamodb.Table(
      this,
      RESOURCE_ID.DYNAMODB_TABLE_PRICES,
      {
        tableName: `${id}-${RESOURCE_ID.DYNAMODB_TABLE_PRICES}`,
        partitionKey: {
          name: "id",
          type: dynamodb.AttributeType.STRING,
        },
        stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      }
    );

    const ssmParameterEmailAlerts =
      ssm.StringParameter.fromStringParameterAttributes(
        this,
        RESOURCE_ID.SSM_PARAMETER_EMAIL_ALERTS,
        {
          parameterName: `/${id}/EmailAlerts`,
        }
      ).stringValue;

    const snsTopicAlerts = new sns.Topic(this, RESOURCE_ID.SNS_TOPIC_ALERTS, {
      topicName: `${id}-${RESOURCE_ID.SNS_TOPIC_ALERTS}`,
    });
    snsTopicAlerts.addSubscription(
      new snsSubscriptions.EmailSubscription(ssmParameterEmailAlerts)
    );

    const lambdaPriceCheck = new lambdaNodejs.NodejsFunction(
      this,
      RESOURCE_ID.LAMBDA_PRICE_CHECK,
      {
        functionName: `${id}-${RESOURCE_ID.LAMBDA_PRICE_CHECK}`,
        timeout: Duration.seconds(20),
        memorySize: 512,
        architecture: lambda.Architecture.ARM_64,
        tracing: lambda.Tracing.ACTIVE,
        entry: path.join(__dirname, "..", "src", "lambdas", "price-check.ts"),
        environment: {
          TABLE_NAME: dynamoDbTablePrices.tableName,
        },
      }
    );

    const lambdaNotification = new lambdaNodejs.NodejsFunction(
      this,
      RESOURCE_ID.LAMBDA_NOTOFICATION,
      {
        functionName: `${id}-${RESOURCE_ID.LAMBDA_NOTOFICATION}`,
        timeout: Duration.seconds(20),
        memorySize: 512,
        architecture: lambda.Architecture.ARM_64,
        tracing: lambda.Tracing.ACTIVE,
        entry: path.join(
          __dirname,
          "..",
          "src",
          "lambdas",
          "price-notification.ts"
        ),
      }
    );

    const lambdaPriceCheckAlarm = new cloudwatch.Alarm(
      this,
      RESOURCE_ID.LAMBDA_PRICE_CHECK_ALARM,
      {
        alarmName: `${id}-Errors-${RESOURCE_ID.LAMBDA_PRICE_CHECK_ALARM}`,
        metric: lambdaPriceCheck.metricErrors({
          period: Duration.minutes(15),
          statistic: "max",
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );

    const lambdaNotificationAlarm = new cloudwatch.Alarm(
      this,
      RESOURCE_ID.LAMBDA_NOTOFICATION_ALARM,
      {
        alarmName: `${id}-Errors-${RESOURCE_ID.LAMBDA_NOTOFICATION_ALARM}`,
        metric: lambdaNotification.metricErrors({
          period: Duration.minutes(15),
          statistic: "max",
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );

    [lambdaPriceCheckAlarm, lambdaNotificationAlarm].forEach((alarm) => {
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(snsTopicAlerts));
      alarm.addInsufficientDataAction(
        new cloudwatchActions.SnsAction(snsTopicAlerts)
      );
      alarm.addOkAction(new cloudwatchActions.SnsAction(snsTopicAlerts));
    });

    lambdaNotification.addEventSource(
      new awsLambdaEventSources.DynamoEventSource(dynamoDbTablePrices, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 1,
      })
    );

    lambdaNotification.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: ["*"],
      })
    );

    dynamoDbTablePrices.grantReadWriteData(lambdaPriceCheck);

    new events.Rule(this, RESOURCE_ID.SCHEDULED_EVENT, {
      ruleName: `${id}-${RESOURCE_ID.SCHEDULED_EVENT}`,
      schedule: events.Schedule.rate(Duration.minutes(15)),
      targets: [new targets.LambdaFunction(lambdaPriceCheck)],
    });
  }
}
