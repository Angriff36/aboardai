import { describe, expect, it } from 'vitest';
import type { ModelDefinition } from '@aboardai/types';
import { getAvailableCursorModels } from '@/components/views/board-view/shared/model-constants';

describe('getAvailableCursorModels', () => {
  it('uses live Cursor discovery as the complete inventory', () => {
    const live = [
      {
        id: 'cursor-composer-2.5',
        name: 'Composer 2.5',
        provider: 'cursor',
      },
      {
        id: 'cursor-grok-4.6-high-fast',
        name: 'Cursor Grok 4.6 Fast',
        provider: 'cursor',
      },
    ] as ModelDefinition[];

    const result = getAvailableCursorModels(
      ['cursor-composer-1', 'cursor-composer-2.5', 'cursor-grok-4.6-high-fast'],
      live
    );

    expect(result.map((model) => model.id)).toEqual([
      'cursor-composer-2.5',
      'cursor-grok-4.6-high-fast',
    ]);
    expect(result).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'cursor-composer-1' })])
    );
  });
});
