export {
  type IObjectStorage,
  type ObjectHead,
  ObjectStorageError,
  type ObjectStorageErrorKind,
  type PresignedPost,
  type PresignPostInput,
  type PutObjectInput,
} from './object-storage.interface';
export { S3ObjectStorage, type S3ObjectStorageOptions, type StorageCredentials } from './s3-object-storage';
export { InMemoryObjectStorage } from './memory-object-storage';
