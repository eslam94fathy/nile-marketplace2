import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { inject } from 'vitest';
import { type S3ObjectStorageOptions } from '../../src/pkg/storage';

export const TEST_STORAGE_REGION = 'us-east-1';
const TEST_STORAGE_TIMEOUT_MS = 5000;

export interface TestBucket {
  bucket: string;
  /** Options for an `S3ObjectStorage` on this bucket. */
  options: S3ObjectStorageOptions;
  cleanup(): Promise<void>;
}

function adminClient(): S3Client {
  return new S3Client({
    region: TEST_STORAGE_REGION,
    endpoint: inject('storageEndpoint'),
    forcePathStyle: true,
    credentials: {
      accessKeyId: inject('storageAccessKeyId'),
      secretAccessKey: inject('storageSecretAccessKey'),
    },
  });
}

/** Anyone may read `public/*`, as through CloudFront (docker-compose sets the same, architecture §14.9). */
function publicReadPolicy(bucket: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/public/*`],
      },
    ],
  });
}

/** One MinIO bucket per test file (the P0-Q9 isolation pattern), emptied and removed at cleanup. */
export async function createTestBucket(): Promise<TestBucket> {
  const bucket = `test-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = adminClient();
  await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  await admin.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: publicReadPolicy(bucket) }));
  return {
    bucket,
    options: {
      bucket,
      region: TEST_STORAGE_REGION,
      timeoutMs: TEST_STORAGE_TIMEOUT_MS,
      endpoint: inject('storageEndpoint'),
      credentials: {
        accessKeyId: inject('storageAccessKeyId'),
        secretAccessKey: inject('storageSecretAccessKey'),
      },
    },
    async cleanup() {
      try {
        for (;;) {
          const listed = await admin.send(new ListObjectsV2Command({ Bucket: bucket }));
          const keys = (listed.Contents ?? []).flatMap((object) => (object.Key ? [{ Key: object.Key }] : []));
          if (keys.length === 0) break;
          await admin.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
        }
        await admin.send(new DeleteBucketCommand({ Bucket: bucket }));
      } finally {
        admin.destroy();
      }
    },
  };
}
