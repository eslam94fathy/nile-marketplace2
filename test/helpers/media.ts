import sharp from 'sharp';
import request from 'supertest';
import { type MediaDto, type UploadTicketDto } from '../../src/app/media/dto/media-response.dto';
import { successBody } from './http';
import { API } from './identity';
import { type TestApp } from './test-app';

/** A solid-colour test image of the given size and format. */
export function testImage(
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp' = 'jpeg',
): Promise<Buffer> {
  const image = sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } });
  return image.toFormat(format).toBuffer();
}

/** A JPEG carrying a camera make and GPS coordinates in its EXIF block. */
export function jpegWithGps(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 30 } } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'PhoneCo' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '30/1 2/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '31/1 14/1 0/1',
      },
    })
    .toBuffer();
}

/** What a browser does with the presigned form: the fields first, the file last. */
export function postToStorage(
  form: UploadTicketDto['upload'],
  body: Buffer,
  contentType: string,
): Promise<Response> {
  const data = new FormData();
  for (const [name, value] of Object.entries(form.fields)) data.append(name, value);
  data.append('file', new Blob([body], { type: contentType }));
  return fetch(form.url, { method: 'POST', body: data });
}

/** The media endpoints of spec 14 §4 for one caller. */
export function mediaApi(t: TestApp, token: string) {
  const auth = { Authorization: `Bearer ${token}` };

  const requestUpload = (body: object) => request(t.app).post(`${API}/media/uploads`).set(auth).send(body);
  const complete = (mediaId: string) =>
    request(t.app).post(`${API}/media/uploads/${mediaId}/complete`).set(auth);
  const get = (mediaId: string) => request(t.app).get(`${API}/media/${mediaId}`).set(auth);

  /** Ticket → upload to storage → complete; returns the ticket and the complete response. */
  async function upload(purpose: string, bytes: Buffer, contentType: string) {
    const res = await requestUpload({ purpose, contentType, sizeBytes: bytes.length });
    if (res.status !== 201)
      throw new Error(`upload request failed: ${res.status} ${JSON.stringify(res.body)}`);
    const ticket = successBody<UploadTicketDto>(res).data;
    const stored = await postToStorage(ticket.upload, bytes, contentType);
    if (stored.status !== 204) throw new Error(`storage refused the upload: ${stored.status}`);
    return { ticket, completed: await complete(ticket.media.id) };
  }

  const media = async (mediaId: string) => successBody<MediaDto>(await get(mediaId)).data;

  return { requestUpload, complete, get, upload, media };
}
