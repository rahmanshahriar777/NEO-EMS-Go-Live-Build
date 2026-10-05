import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ClockInDto } from './attendance.dto';

async function validateLocation(location?: string): Promise<string[]> {
  const dto = plainToInstance(ClockInDto, { location });
  const errors = await validate(dto);
  const locErrors = errors.filter(e => e.property === 'location');
  return locErrors.flatMap(e => Object.values(e.constraints ?? {}));
}

describe('ClockInDto.location coordinate validation', () => {
  it('accepts free-text locations untouched', async () => {
    for (const loc of ['Office - Floor 4', 'Remote', 'Client site', '51.5074, not-a-number']) {
      await expect(validateLocation(loc)).resolves.toEqual([]);
    }
  });

  it('accepts valid coordinates', async () => {
    await expect(validateLocation('51.5074,-0.1278')).resolves.toEqual([]);
    await expect(validateLocation('-90, 180')).resolves.toEqual([]);
    await expect(validateLocation('0,0')).resolves.toEqual([]);
  });

  it('rejects out-of-range coordinate-looking strings', async () => {
    for (const loc of ['91,0', '0,181', '-91,-181', '45, 999']) {
      const messages = await validateLocation(loc);
      expect(messages.length).toBeGreaterThan(0);
    }
  });

  it('treats non-coordinate-shaped strings as free text', async () => {
    // '51.5074,' does not match the lat,lng shape, so it is left alone as
    // free text rather than rejected.
    await expect(validateLocation('51.5074,')).resolves.toEqual([]);
  });

  it('allows location to be omitted', async () => {
    await expect(validateLocation(undefined)).resolves.toEqual([]);
  });
});
