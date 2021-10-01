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

export class PriceMonitorStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DB to store price records
    const dynamoDbTable = new dynamodb.Table(this, "PriceTable", {
      partitionKey: {
        name: "id",
        type: dynamodb.AttributeType.STRING,
      },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // CloudFormation param for email address
    const paramPriceMonitorAlertsEmailAddress = new cdk.CfnParameter(
      this,
      "PriceMonitorAlertsEmailAddress",
      {
        type: "String",
        description: "Email address for CloudWatch alerts",
      }
    );

    // SNS for lambda alerts
    const topicPriceMonitorAlerts = new sns.Topic(this, "PriceMonitorAlerts");
    topicPriceMonitorAlerts.addSubscription(
      new snsSubscriptions.EmailSubscription(
        paramPriceMonitorAlertsEmailAddress.valueAsString
      )
    );

    // Lambda: Price Check
    const lambdaPriceCheck = new lambdaNodejs.NodejsFunction(
      this,
      "PriceCheck",
      {
        handler: "handler",
        timeout: cdk.Duration.seconds(20),
        memorySize: 256,
        tracing: lambda.Tracing.ACTIVE,
        entry: path.join(__dirname, "..", "src", "lambdas", "price-check.ts"),
        environment: {
          TABLE_NAME: dynamoDbTable.tableName,
        },
      }
    );

    // Lambda: Notification
    const lambdaNotification = new lambdaNodejs.NodejsFunction(
      this,
      "Notification",
      {
        handler: "handler",
        timeout: cdk.Duration.seconds(20),
        memorySize: 256,
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

    // Alert for Lambda Price Check
    const alarmPriceCheckLambda = new cloudwatch.Alarm(
      this,
      "PriceCheckLambdaAlarm",
      {
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

    // Alert for Lambda Notification
    const alarmNotificationLambda = new cloudwatch.Alarm(
      this,
      "NotificationLambdaAlarm",
      {
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

    // Alert, insufficient data and OK notificatoin for Lambda Price Check email subscription
    alarmPriceCheckLambda.addAlarmAction(
      new cloudwatchActions.SnsAction(topicPriceMonitorAlerts)
    );
    alarmPriceCheckLambda.addInsufficientDataAction(
      new cloudwatchActions.SnsAction(topicPriceMonitorAlerts)
    );
    alarmPriceCheckLambda.addOkAction(
      new cloudwatchActions.SnsAction(topicPriceMonitorAlerts)
    );

    // Alert, insufficient data and OK notificatoin  for Lambda Notification email subscription
    alarmNotificationLambda.addAlarmAction(
      new cloudwatchActions.SnsAction(topicPriceMonitorAlerts)
    );
    alarmNotificationLambda.addInsufficientDataAction(
      new cloudwatchActions.SnsAction(topicPriceMonitorAlerts)
    );
    alarmNotificationLambda.addOkAction(
      new cloudwatchActions.SnsAction(topicPriceMonitorAlerts)
    );

    // Subscribe lmbda to db stream
    lambdaNotification.addEventSource(
      new awsLambdaEventSources.DynamoEventSource(dynamoDbTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 1,
      })
    );

    // authorize lambda to send email
    lambdaNotification.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: ["*"],
      })
    );

    // rules
    const ruleEveryOneHour = new events.Rule(this, "EveryOneHour", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
    });

    // add rules target
    ruleEveryOneHour.addTarget(new targets.LambdaFunction(lambdaPriceCheck));

    // grant db access
    dynamoDbTable.grantReadWriteData(lambdaPriceCheck);
  }
}
