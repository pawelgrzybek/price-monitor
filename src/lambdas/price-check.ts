import fetch from "node-fetch";
import cheerio from "cheerio";
import {
  DynamoDBClient,
  ScanCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { ScheduledHandler } from "aws-lambda";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { captureAWSv3Client, getSegment, Segment } from "aws-xray-sdk-core";

// envs
const { AWS_REGION: region, TABLE_NAME: TableName } = process.env;

// clients init
const dbClient = captureAWSv3Client(new DynamoDBClient({ region }));

const handler: ScheduledHandler = async (event) => {
  console.log(`event: ${JSON.stringify(event)}`);
  const segment = getSegment() as Segment;

  try {
    console.log("db scan: start");

    const { Items, Count } = await dbClient.send(
      new ScanCommand({
        TableName,
      })
    );
    console.log("db scan: end");

    if (!Count) {
      console.log("db empty");
      return;
    }

    const itmesUnmarshall = Items?.map((i) => unmarshall(i)) as PriceRow[];

    console.log("fetch: start");
    const subsegmentScrape = segment.addNewSubsegment("Fetch URLs");
    const newPrices = await Promise.all(
      itmesUnmarshall.map(({ url }) =>
        fetch(url).then((response) => response.text())
      )
    );
    subsegmentScrape.close();
    console.log("fetch: end");

    console.log("generate diff: start");
    const subsegmentGenerateDiff = segment.addNewSubsegment("Generate diff");
    const diff = itmesUnmarshall.reduce((acc, item, index) => {
      const $ = cheerio.load(newPrices[index]);
      const price = $(item.selector).text();

      if (price === item.price) {
        return acc;
      }

      return [...acc, { ...item, price }];
    }, [] as PriceRow[]);
    subsegmentGenerateDiff.close();
    console.log("generate diff: end");

    if (diff.length) {
      console.log(`db update: start`);
      console.log(`diff: ${JSON.stringify(diff)}`);
      const updateCommands = diff.map((item) =>
        dbClient.send(
          new PutItemCommand({
            TableName,
            Item: marshall(item),
          })
        )
      );
      await Promise.all(updateCommands);
      console.log(`db update: end`);
    }

    return;
  } catch (error) {
    console.error(error);
    throw new Error(error instanceof Error ? error.message : String(error));
  }
};

export { handler };
