import type { Store } from '../store.ts'
import type { CoreStateCommit, CoreStateRepository, CoreStateRestore } from './state-repository.ts'

/** Store 的 SQLite adapter；事务边界由 Store 统一掌握，Core 不依赖 Store。 */
export class StoreCoreStateRepository implements CoreStateRepository {
  private readonly store: Store

  constructor(store: Store) {
    this.store = store
  }

  commit(snapshot: CoreStateCommit): void {
    this.store.saveCoreStateTransaction(snapshot)
  }

  restore(roomId: string, eventLimit = 100): CoreStateRestore | undefined {
    return this.store.loadCoreState(roomId, eventLimit)
  }
}
