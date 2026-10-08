// class-transformer ships cjs/storage.js without typings at that path; its types live in types/storage.d.ts.
declare module 'class-transformer/cjs/storage' {
  export { defaultMetadataStorage } from 'class-transformer/types/storage';
}
