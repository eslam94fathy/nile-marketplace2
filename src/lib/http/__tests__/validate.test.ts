import { Type } from 'class-transformer';
import { ArrayMaxSize, IsInt, IsOptional, IsString, Length, Max, Min, ValidateNested } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../error';
import {
  IsEgyptianMobile,
  IsMoney,
  IsRate,
  MaxBytes,
  NormalizeEmail,
  Optional,
  PatchDto,
  Trim,
  validateDto,
} from '..';

class LineDto {
  @IsMoney()
  price!: string;

  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;
}

class CreateDto {
  @Trim()
  @IsString()
  @Length(1, 10)
  name!: string;

  @NormalizeEmail()
  @IsString()
  email!: string;

  @MaxBytes(8)
  password!: string;

  @ValidateNested({ each: true })
  @ArrayMaxSize(2)
  @Type(() => LineDto)
  lines!: LineDto[];
}

class UpdateDto extends PatchDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEgyptianMobile()
  phone?: string;

  @IsOptional()
  @IsRate()
  rate?: string;
}

class NoteDto {
  @Optional()
  @IsString()
  note?: string;
}

async function detailsOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe('VALIDATION_FAILED');
  return (error as AppError).details ?? [];
}

const valid = {
  name: '  Nile  ',
  email: ' A@B.COM ',
  password: 'secret',
  lines: [{ price: '10.50', quantity: 2 }],
};

describe('lib/http validateDto', () => {
  it('returns a typed instance with transforms applied', async () => {
    const dto = await validateDto(CreateDto, valid);
    expect(dto).toBeInstanceOf(CreateDto);
    expect(dto.name).toBe('Nile');
    expect(dto.email).toBe('a@b.com');
    expect(dto.lines[0]).toBeInstanceOf(LineDto);
  });

  it('rejects unknown keys instead of stripping them', async () => {
    const details = await detailsOf(validateDto(CreateDto, { ...valid, isAdmin: true }));
    expect(details).toContainEqual(
      expect.objectContaining({ field: 'isAdmin', constraint: 'whitelistValidation' }),
    );
  });

  it('reports nested fields with their path', async () => {
    const details = await detailsOf(
      validateDto(CreateDto, { ...valid, lines: [{ price: '1.234', quantity: 0, extra: 1 }] }),
    );
    const fields = details.map((d) => `${d.field}:${d.constraint}`);
    expect(fields).toEqual(
      expect.arrayContaining([
        'lines[0].price:matches',
        'lines[0].quantity:min',
        'lines[0].extra:whitelistValidation',
      ]),
    );
  });

  it('does no implicit conversion', async () => {
    const details = await detailsOf(
      validateDto(CreateDto, { ...valid, lines: [{ price: '1.00', quantity: '2' }] }),
    );
    expect(details).toContainEqual(
      expect.objectContaining({ field: 'lines[0].quantity', constraint: 'isInt' }),
    );
  });

  it('limits UTF-8 bytes, not characters', async () => {
    const details = await detailsOf(validateDto(CreateDto, { ...valid, password: 'ééééé' })); // 10 bytes
    expect(details).toContainEqual(expect.objectContaining({ field: 'password', constraint: 'maxBytes' }));
  });

  it('rejects non-object bodies', async () => {
    for (const body of [null, [], 'text', 42]) {
      const details = await detailsOf(validateDto(CreateDto, body));
      expect(details[0]).toMatchObject({ field: '(body)', constraint: 'isObject' });
    }
  });

  it('PatchDto rejects an empty body and accepts a partial one', async () => {
    const details = await detailsOf(validateDto(UpdateDto, {}));
    expect(details).toEqual([expect.objectContaining({ field: '(body)', constraint: 'atLeastOneField' })]);
    await expect(validateDto(UpdateDto, { name: 'x' })).resolves.toBeInstanceOf(UpdateDto);
  });

  it('PatchDto does not accept its hidden property from clients', async () => {
    const details = await detailsOf(validateDto(UpdateDto, { name: 'x', __atLeastOneField: 1 }));
    expect(details).toContainEqual(
      expect.objectContaining({ field: '(body)', constraint: 'atLeastOneField' }),
    );
  });

  it('validates money, rates and Egyptian mobiles', async () => {
    const details = await detailsOf(validateDto(UpdateDto, { phone: '+201312345678', rate: '1.5' }));
    expect(details.map((d) => d.field).sort()).toEqual(['phone', 'rate']);
    await expect(validateDto(UpdateDto, { phone: '+201012345678', rate: '0.1250' })).resolves.toBeDefined();
  });

  it('Optional() allows an absent field but rejects null (spec 01 §1.1 `opt`)', async () => {
    await expect(validateDto(NoteDto, {})).resolves.toBeInstanceOf(NoteDto);
    await expect(validateDto(NoteDto, { note: 'x' })).resolves.toBeInstanceOf(NoteDto);
    const details = await detailsOf(validateDto(NoteDto, { note: null }));
    expect(details).toContainEqual(expect.objectContaining({ field: 'note', constraint: 'isString' }));
  });
});
