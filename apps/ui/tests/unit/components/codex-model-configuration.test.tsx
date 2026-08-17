import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodexModelConfiguration } from '@/components/views/settings-view/providers/codex-model-configuration';

describe('CodexModelConfiguration', () => {
  it('renders the models discovered from the locally installed Codex CLI', () => {
    render(
      <CodexModelConfiguration
        availableModels={[
          {
            id: 'codex-gpt-5.5',
            label: 'GPT-5.5',
            description: 'Frontier model from the local CLI',
            hasThinking: true,
            supportsVision: true,
            tier: 'standard',
            isDefault: true,
          },
          {
            id: 'codex-gpt-5.4-mini',
            label: 'GPT-5.4-Mini',
            description: 'Fast local CLI model',
            hasThinking: true,
            supportsVision: true,
            tier: 'basic',
            isDefault: false,
          },
        ]}
        enabledCodexModels={['codex-gpt-5.5', 'codex-gpt-5.4-mini']}
        codexDefaultModel="codex-gpt-5.5"
        isSaving={false}
        onDefaultModelChange={vi.fn()}
        onModelToggle={vi.fn()}
      />
    );

    expect(screen.getAllByText('GPT-5.5')).not.toHaveLength(0);
    expect(screen.getByText('GPT-5.4-Mini')).toBeInTheDocument();
    expect(screen.queryByText('GPT-5.3-Codex')).not.toBeInTheDocument();
  });
});
