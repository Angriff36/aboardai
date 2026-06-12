/**
 * Permanent canary: proves @angriff36/manifest 2.4.1 installs and embeds correctly on Windows.
 * Validates: compileToIR, RuntimeEngine construction, createInstance, runCommand (success),
 * guard-denial semantics (success:false — NOT a throw), and emittedEvents.
 *
 * Guard-denial semantics observed: runCommand returns {success: false, guardFailure: {...}}
 * This is important for Task 1 — denial is a structured result, not an exception.
 *
 * Import specifiers that work:
 *   import { compileToIR } from '@angriff36/manifest/ir-compiler'
 *   import { RuntimeEngine } from '@angriff36/manifest'
 */

import { describe, it, expect } from 'vitest';
import { compileToIR } from '@angriff36/manifest/ir-compiler';
import { RuntimeEngine } from '@angriff36/manifest';

// A minimal manifest: one entity with one property, one guarded command, and an emit.
// Guard: command can only run when status == "active" (so calling it when status == "new" → denied).
const HELLO_MANIFEST = `
entity Greeter {
  property status: string = "new"
  property name: string = "world"

  command activate() {
    guard self.status == "new"
    mutate status = "active"
    emit Activated
  }

  command sayHello(message: string) {
    guard self.status == "active"
    emit HelloSaid
  }
}

event Activated: "greeter.activated" {
  greeterId: string
}

event HelloSaid: "greeter.hello_said" {
  greeterId: string
  message: string
}
`;

describe('Manifest 2.4.1 embed smoke test', () => {
  it('compileToIR produces clean diagnostics', async () => {
    const { ir, diagnostics } = await compileToIR(HELLO_MANIFEST);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors, `Compile errors: ${JSON.stringify(errors)}`).toHaveLength(0);
    expect(ir).not.toBeNull();
  });

  it('RuntimeEngine constructs with compiled IR', async () => {
    const { ir } = await compileToIR(HELLO_MANIFEST);
    expect(ir).not.toBeNull();
    const engine = new RuntimeEngine(ir!, {});
    expect(engine).toBeDefined();
  });

  it('createInstance returns an instance', async () => {
    const { ir } = await compileToIR(HELLO_MANIFEST);
    const engine = new RuntimeEngine(ir!, {});
    const instance = await engine.createInstance('Greeter', { id: 'greeter-1' });
    expect(instance).toBeDefined();
    expect(instance?.id).toBe('greeter-1');
  });

  it('runCommand succeeds and emits events', async () => {
    const { ir } = await compileToIR(HELLO_MANIFEST);
    const engine = new RuntimeEngine(ir!, {});
    await engine.createInstance('Greeter', { id: 'greeter-1' });

    // First activate (guard: status == "new" → passes)
    const activateResult = await engine.runCommand(
      'activate',
      {},
      { entityName: 'Greeter', instanceId: 'greeter-1' }
    );
    expect(activateResult.success).toBe(true);
    expect(activateResult.emittedEvents.length).toBeGreaterThanOrEqual(1);

    // Then sayHello (guard: status == "active" → passes after activate)
    const helloResult = await engine.runCommand(
      'sayHello',
      { message: 'hello from AboardAI' },
      { entityName: 'Greeter', instanceId: 'greeter-1' }
    );
    expect(helloResult.success).toBe(true);
    expect(helloResult.emittedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('guard-violating runCommand returns success:false (not a throw) — Task 1 denial semantics confirmed', async () => {
    const { ir } = await compileToIR(HELLO_MANIFEST);
    const engine = new RuntimeEngine(ir!, {});
    await engine.createInstance('Greeter', { id: 'greeter-2' });

    // sayHello guard requires status == "active", but status is "new" at creation
    // This verifies guard-denial is a structured result, not an exception.
    const result = await engine.runCommand(
      'sayHello',
      { message: 'should be denied' },
      { entityName: 'Greeter', instanceId: 'greeter-2' }
    );

    // GUARD-DENIAL SEMANTICS: success:false with guardFailure populated — NOT a throw
    expect(result.success).toBe(false);
    expect(result.guardFailure).toBeDefined();
    expect(result.emittedEvents).toHaveLength(0);
  });
});
