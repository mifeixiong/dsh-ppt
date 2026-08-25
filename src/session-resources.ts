import { rm } from 'node:fs/promises'

export interface SessionOwner {
  agentId: string
  sessionId: string
}

export interface OwnedResource {
  label: string
  dispose(): void | Promise<void>
}

export interface SessionResourceState {
  readonly owner: SessionOwner
  readonly workspace: string
  readonly temporaryPaths: ReadonlySet<string>
  readonly resourceCount: number
}

interface MutableSessionState {
  owner: SessionOwner
  workspace: string
  temporaryPaths: Set<string>
  resources: Set<OwnedResource>
}

function ownerKey(owner: SessionOwner): string {
  if (owner.agentId.trim().length === 0 || owner.sessionId.trim().length === 0) {
    throw new Error('agentId and sessionId are required')
  }
  return `${owner.agentId}\0${owner.sessionId}`
}

export class SessionResourceRegistry {
  private readonly sessions = new Map<string, MutableSessionState>()
  private disposed = false

  open(owner: SessionOwner, workspace: string): SessionResourceState {
    if (this.disposed) throw new Error('session resource registry is disposed')
    const key = ownerKey(owner)
    const current = this.sessions.get(key)
    if (current !== undefined) {
      if (current.workspace !== workspace) throw new Error('session workspace cannot change while resources are active')
      return this.snapshot(current)
    }
    const state: MutableSessionState = {
      owner: { ...owner }, workspace, temporaryPaths: new Set(), resources: new Set(),
    }
    this.sessions.set(key, state)
    return this.snapshot(state)
  }

  track(owner: SessionOwner, resource: OwnedResource): () => void {
    const state = this.require(owner)
    state.resources.add(resource)
    return () => state.resources.delete(resource)
  }

  trackTemporaryPath(owner: SessionOwner, path: string): () => void {
    const state = this.require(owner)
    state.temporaryPaths.add(path)
    return () => state.temporaryPaths.delete(path)
  }

  state(owner: SessionOwner): SessionResourceState | undefined {
    const state = this.sessions.get(ownerKey(owner))
    return state === undefined ? undefined : this.snapshot(state)
  }

  async release(owner: SessionOwner): Promise<void> {
    const key = ownerKey(owner)
    const state = this.sessions.get(key)
    if (state === undefined) return
    this.sessions.delete(key)
    const errors: unknown[] = []
    for (const resource of [...state.resources].reverse()) {
      try {
        await resource.dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    for (const path of state.temporaryPaths) {
      try {
        await rm(path, { recursive: true, force: true })
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `failed to release ${errors.length} PPT session resources`)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const owners = [...this.sessions.values()].map(state => state.owner)
    const settlements = await Promise.allSettled(owners.map(owner => this.release(owner)))
    const errors = settlements.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length > 0) throw new AggregateError(errors, `failed to dispose ${errors.length} PPT sessions`)
  }

  private require(owner: SessionOwner): MutableSessionState {
    const state = this.sessions.get(ownerKey(owner))
    if (state === undefined) throw new Error('session resources must be opened before tracking')
    return state
  }

  private snapshot(state: MutableSessionState): SessionResourceState {
    return Object.freeze({
      owner: Object.freeze({ ...state.owner }),
      workspace: state.workspace,
      temporaryPaths: new Set(state.temporaryPaths),
      resourceCount: state.resources.size,
    })
  }
}
