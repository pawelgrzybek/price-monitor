import { unmarshall } from "@aws-sdk/util-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import getEmailTemplate from "../utils/getEmailTemplate.js";
import { DynamoDBStreamHandler } from "aws-lambda";
import { captureAWSv3Client, getSegment, Segment } from "aws-xray-sdk-core";

// envs
const { AWS_REGION: region } = process.env;

// clients init
// @ts-ignore
const sesClient = captureAWSv3Client(new SESClient({ region }));

const handler: DynamoDBStreamHandler = async (event) => {
  console.log(`event: ${JSON.stringify(event)}`);

  const record = event.Records[0];
  const {
    // @ts-ignore
    dynamodb: { NewImage, OldImage },
    eventName,
  } = record;

  if (eventName !== "MODIFY") {
    console.log("event is not MODIFY");
    return;
  }

  const unmarshalledNewImage = unmarshall(NewImage);
  const unmarshalledOldImage = unmarshall(OldImage);

  const { price, item, email, url } = unmarshalledNewImage;

  try {
    console.log("emain send: start");
    await sesClient.send(
      // @ts-ignore
      new SendEmailCommand({
        Source: email,
        Destination: {
          ToAddresses: [email],
        },
        Message: {
          Body: {
            Html: {
              Charset: "UTF-8",
              Data: getEmailTemplate({
                item,
                url,
                oldPrice: unmarshalledOldImage.price,
                newPrice: price,
              }),
            },
          },
          Subject: {
            Charset: "UTF-8",
            Data: `💰 Price alert - ${item}`,
          },
        },
      })
    );
    console.log("emain send: end");

    return;
  } catch (error) {
    console.error(error);
    throw new Error("Uuuups!");
  }
};

export { handler };
