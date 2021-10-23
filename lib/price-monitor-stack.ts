import * as path from "path";
import * as cdk from "@aws-cdk/core";
import * as events from "@aws-cdk/aws-events";
import * as targets from "@aws-cdk/aws-events-targets";
import * as lambdaNodejs from "@aws-cdk/aws-lambda-nodejs";
import * as lambda from "@aws-cdk/aws-lambda";
import * as dynamodb from "@aws-cdk/aws-dynamodb";
import * as iam from "@aws-cdk/aws-iam";
import * as awsLambdaEventSources from "@aws-cdk/aws-lambda-event-sources";
import * as cloudwatch from "@aws-cdk/aws-cloudwatch";
import * as cloudwatchActions from "@aws-cdk/aws-cloudwatch-actions";
import * as sns from "@aws-cdk/aws-sns";
import * as snsSubscriptions from "@aws-cdk/aws-sns-subscriptions";
import * as ssm from "@aws-cdk/aws-ssm";

const RESOURCE_ID_DYNAMODB_TABLE_PRICES = "DynamoDbTablePrices";
const RESOURCE_ID_SSM_PARAMETER_EMAIL_ALERTS = "SsmParameterEmailAlerts";
const RESOURCE_ID_SNS_TOPIC_ALERTS = "SnsTopicAlerts";
const RESOURCE_ID_LAMBDA_PRICE_CHECK = "LambdaPriceCheck";
const RESOURCE_ID_LAMBDA_NOTOFICATION = "LambdaNotification";
const RESOURCE_ID_LAMBDA_PRICE_CHECK_ALARM = "LambdaPriceCheckAlarm";
const RESOURCE_ID_LAMBDA_NOTOFICATION_ALARM = "LambdaNotificationAlarm";
const RESOURCE_ID_SCHEDULED_EVENT = "ScheduledEvent";

export class PriceMonitorStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const dynamoDbTablePrices = new dynamodb.Table(
      this,
      RESOURCE_ID_DYNAMODB_TABLE_PRICES,
      {
        tableName: `${id}-${RESOURCE_ID_DYNAMODB_TABLE_PRICES}`,
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
        RESOURCE_ID_SSM_PARAMETER_EMAIL_ALERTS,
        {
          parameterName: `/${id}/EmailAlerts`,
        }
      ).stringValue;

    const snsTopicAlerts = new sns.Topic(this, RESOURCE_ID_SNS_TOPIC_ALERTS, {
      topicName: `${id}-${RESOURCE_ID_SNS_TOPIC_ALERTS}`,
    });
    snsTopicAlerts.addSubscription(
      new snsSubscriptions.EmailSubscription(ssmParameterEmailAlerts)
    );

    const lambdaPriceCheck = new lambdaNodejs.NodejsFunction(
      this,
      RESOURCE_ID_LAMBDA_PRICE_CHECK,
      {
        functionName: `${id}-${RESOURCE_ID_LAMBDA_PRICE_CHECK}`,
        timeout: cdk.Duration.seconds(20),
        memorySize: 256,
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
      RESOURCE_ID_LAMBDA_NOTOFICATION,
      {
        functionName: `${id}-${RESOURCE_ID_LAMBDA_NOTOFICATION}`,
        timeout: cdk.Duration.seconds(20),
        memorySize: 256,
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
      RESOURCE_ID_LAMBDA_PRICE_CHECK_ALARM,
      {
        alarmName: `${id}-Errors-${RESOURCE_ID_LAMBDA_PRICE_CHECK_ALARM}`,
        metric: lambdaPriceCheck.metricErrors({
          period: cdk.Duration.minutes(15),
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
      RESOURCE_ID_LAMBDA_NOTOFICATION_ALARM,
      {
        alarmName: `${id}-Errors-${RESOURCE_ID_LAMBDA_NOTOFICATION_ALARM}`,
        metric: lambdaNotification.metricErrors({
          period: cdk.Duration.minutes(15),
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

    new events.Rule(this, RESOURCE_ID_SCHEDULED_EVENT, {
      ruleName: `${id}-${RESOURCE_ID_SCHEDULED_EVENT}`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(lambdaPriceCheck)],
    });
  }
}
