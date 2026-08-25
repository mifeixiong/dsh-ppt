import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PythonRuntime } from '../../src/python.ts'
import { SessionResourceRegistry } from '../../src/session-resources.ts'
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts'

describe('Python runtime through DSH subprocess and sandbox', () => {
  let workspace: TestWorkspace
  let resources: SessionResourceRegistry
  let subprocess: LocalSubprocessRuntime
  let sandbox: LocalSandboxProvider

  beforeEach(async () => {
    workspace = await createTestWorkspace('dsh-ppt-python-')
    resources = new SessionResourceRegistry()
    const context = new Context()
    subprocess = new LocalSubprocessRuntime(context)
    sandbox = new LocalSandboxProvider(context, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5_000 })
  })

  afterEach(async () => {
    await resources.dispose()
    await workspace.cleanup()
  })

  async function executable(name: string, source: string): Promise<string> {
    const path = join(workspace.root, name)
    await writeFile(path, source)
    await chmod(path, 0o755)
    return path
  }

  it('runs independently, truncates output, and reports changed artifacts', async () => {
    const command = await executable('fake-python', `#!/bin/sh
if [ "$1" = "-c" ]; then echo ready; exit 0; fi
cat >/dev/null
mkdir -p assets/charts
printf 'x,y\\n1,2\\n' > assets/charts/chart.csv
/usr/bin/yes X | /usr/bin/head -c 90000
`)
    const runtime = new PythonRuntime(subprocess, sandbox, resources, command)
    const result = await runtime.execute({ agentId: 'a', sessionId: 'a' }, workspace.root, {
      code: 'print("chart")', expected_outputs: ['assets/charts/chart.csv'], timeout_ms: 5_000,
    })
    expect(result.exit_code).toBe(0)
    expect(result.stdout_truncated).toBe(true)
    expect(result.artifacts).toEqual([expect.objectContaining({ path: 'assets/charts/chart.csv', mime_type: 'text/csv' })])
  })

  it('reports dependency failure before user code runs', async () => {
    const command = await executable('missing-python', '#!/bin/sh\necho "No module named matplotlib" >&2\nexit 3\n')
    const runtime = new PythonRuntime(subprocess, sandbox, resources, command)
    await expect(runtime.execute({ agentId: 'b', sessionId: 'b' }, workspace.root, { code: 'print(1)' }))
      .rejects.toMatchObject({ code: 'PYTHON_DEPENDENCY_MISSING' })
  })

  it('terminates a timed-out process tree with a stable error', async () => {
    const command = await executable('slow-python', '#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\ncat >/dev/null\nsleep 10\n')
    const runtime = new PythonRuntime(subprocess, sandbox, resources, command)
    await expect(runtime.execute({ agentId: 'c', sessionId: 'c' }, workspace.root, { code: 'print(1)', timeout_ms: 1_000 }))
      .rejects.toMatchObject({ code: 'PPT_RESOURCE_LIMIT' })
  })

  it('terminates a cancelled process tree with a stable abort error', async () => {
    const command = await executable('cancel-python', '#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\ncat >/dev/null\nsleep 10\n')
    const runtime = new PythonRuntime(subprocess, sandbox, resources, command)
    const controller = new AbortController()
    setTimeout(() => controller.abort('user cancelled'), 150)
    await expect(runtime.execute(
      { agentId: 'd', sessionId: 'd' }, workspace.root, { code: 'print(1)', timeout_ms: 5_000 }, controller.signal,
    )).rejects.toMatchObject({ code: 'PPT_ABORTED' })
  })

  it('rejects a run that creates more files than the hard artifact limit', async () => {
    const command = await executable('many-files-python', `#!/bin/sh
if [ "$1" = "-c" ]; then exit 0; fi
cat >/dev/null
i=1
while [ $i -le 101 ]; do printf x > "generated-$i.txt"; i=$((i + 1)); done
`)
    const runtime = new PythonRuntime(subprocess, sandbox, resources, command)
    await expect(runtime.execute({ agentId: 'e', sessionId: 'e' }, workspace.root, { code: 'print(1)', timeout_ms: 5_000 }))
      .rejects.toMatchObject({ code: 'PPT_RESOURCE_LIMIT' })
  })
})
