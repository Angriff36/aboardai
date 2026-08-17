import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createVerifyAccessHandler } from '@/routes/models/routes/verify-access.js';
import type { SettingsService } from '@/services/settings-service.js';
import { createMockExpressContext } from '../../../utils/mocks.js';

describe('verify model access route', () => {
  let req: Request;
  let res: Response;

  beforeEach(() => {
    ({ req, res } = createMockExpressContext());
  });

  it.each([
    [{ candidates: [{ key: 'x', model: 'cursor-auto', providerKey: 'cursor' }] }, 'projectPath'],
    [{ projectPath: 'C:\\project', candidates: [] }, 'candidate'],
    [
      {
        projectPath: 'C:\\project',
        candidates: Array.from({ length: 21 }, (_, index) => ({
          key: `cursor:${index}`,
          model: `cursor-${index}`,
          displayName: `Cursor ${index}`,
          providerKey: 'cursor',
          providerLabel: 'Cursor',
          isProviderDefault: false,
        })),
      },
      '20',
    ],
    [
      {
        projectPath: 'C:\\project',
        candidates: [
          {
            key: 'cursor:auto',
            model: '',
            displayName: 'Cursor Auto',
            providerKey: 'cursor',
            providerLabel: 'Cursor',
            isProviderDefault: true,
          },
        ],
      },
      'model',
    ],
  ])('rejects malformed request %#', async (body, expectedMessage) => {
    req.body = body;
    const verify = vi.fn();

    await createVerifyAccessHandler({} as SettingsService, verify)(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining(expectedMessage) })
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns independent verification results in request order', async () => {
    const candidates = [
      {
        key: 'cursor:auto',
        model: 'cursor-auto',
        displayName: 'Cursor Auto',
        providerKey: 'cursor',
        providerLabel: 'Cursor',
        isProviderDefault: true,
      },
    ];
    req.body = { projectPath: 'C:\\project', candidates };
    const results = [{ key: 'cursor:auto', status: 'verified' as const }];
    const verify = vi.fn().mockResolvedValue(results);

    await createVerifyAccessHandler({} as SettingsService, verify)(req, res);

    expect(verify).toHaveBeenCalledWith(candidates, 'C:\\project', expect.anything());
    expect(res.json).toHaveBeenCalledWith({ results });
  });
});
