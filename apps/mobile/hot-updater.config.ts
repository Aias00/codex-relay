import { d1Database, r2Storage } from "@hot-updater/cloudflare";
import { expo } from "@hot-updater/expo";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

const accountId = process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!;
const bucketName = process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!;
const cloudflareApiToken = process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!;
const accessKeyId = process.env.HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY;

export default defineConfig({
  build: expo(),
  storage:
    accessKeyId && secretAccessKey
      ? r2Storage({
          bucketName,
          accountId,
          credentials: { accessKeyId, secretAccessKey },
        })
      : r2Storage({ bucketName, accountId, cloudflareApiToken }),
  database: d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
    accountId,
    cloudflareApiToken,
  }),
  updateStrategy: "appVersion", // or "fingerprint"
  signing: { enabled: true, privateKeyPath: "./keys/private-key.pem" },
  patch: {
    enabled: true,
    maxBaseBundles: 2,
  },
});
