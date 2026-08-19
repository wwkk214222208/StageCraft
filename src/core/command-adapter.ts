import type { RoomRuntime } from '../room-runtime.ts'
import type { HumanCommand } from './protocol.ts'
import type { RoomMode, ThinkingStrength, WorldChangeRequest } from '../types.ts'

export interface CoreCommandContext {
  runtime: RoomRuntime
  defaultRoomId: string
}

function record(command: HumanCommand): Record<string, unknown> {
  return command.payload && typeof command.payload === 'object' ? command.payload as Record<string, unknown> : {}
}

function roomIdOf(payload: Record<string, unknown>, fallback: string): string {
  return typeof payload.roomId === 'string' && payload.roomId.trim() ? payload.roomId : fallback
}

/** 组合根中的群聊/导演命令由方案 Handler 负责；这里保留未安装方案时的历史兼容回退及管理命令。 */
export async function dispatchLegacyCommand(context: CoreCommandContext, command: HumanCommand): Promise<void> {
  const payload = record(command)
  const roomId = roomIdOf(payload, context.defaultRoomId)
  const runtime = context.runtime

  switch (command.type) {
    // 仅作为未安装 StageCraft 方案时的历史兼容路径；正式组合根由方案 handler 截获。
    case 'submit-text':
      if (payload.action === 'director-chat') { await runtime.directorChat(roomId, String(payload.text ?? '')); return }
      await runtime.submitTurn(roomId, { text: String(payload.text ?? '') }); return
    case 'select-role':
      await runtime.speak(roomId, String(payload.roleId ?? '')); return
    case 'cancel':
      runtime.cancelTurn(roomId); return
    case 'approve': {
      const action = String(payload.action ?? 'draft')
      if (action === 'speech') {
        const worldChange = payload.worldChange && typeof payload.worldChange === 'object' ? payload.worldChange as WorldChangeRequest : null
        await runtime.approveSpeech(roomId, String(payload.text ?? ''), worldChange); return
      }
      if (action === 'decisions') { await runtime.proceedToDraft(roomId); return }
      if (action === 'world-change') {
        const worldChange = payload.worldChange && typeof payload.worldChange === 'object' ? payload.worldChange as WorldChangeRequest : null
        await runtime.approveWorldChange(roomId, worldChange); return
      }
      runtime.approve(roomId, String(payload.draftId ?? ''), String(payload.text ?? ''), (payload.stateUpdates ?? {}) as Record<string, string>, payload.sceneUpdates as { time?: string; location?: string } | undefined); return
    }
    case 'reject':
      if (payload.action === 'draft') { await runtime.rejectDraft(roomId); return }
      if (payload.action === 'speech') { await runtime.rejectSpeech(roomId); return }
      if (payload.action === 'world-change') { await runtime.rejectWorldChange(roomId); return }
      throw new Error('Unsupported reject action.')
    case 'restart':
      throw new Error('Restart requires an Author Pack and remains on the legacy route for now.')
    case 'edit-proposal':
      throw new Error('Use approve with edited proposal fields.')
    case 'role-management': {
      const operation = String(payload.operation ?? '')
      if (operation === 'set-presence') {
        runtime.setRolePresence(roomId, String(payload.roleId ?? ''), payload.presence as 'present' | 'absent' | 'unavailable')
        return
      }
      if (operation === 'set-thinking') {
        runtime.setRoleThinking(roomId, String(payload.roleId ?? ''), payload.thinkingStrength as ThinkingStrength)
        return
      }
      if (operation === 'set-room-config') {
        runtime.setRoomConfig(roomId, {
          mode: payload.mode === 'chat' || payload.mode === 'director' ? payload.mode as RoomMode : undefined,
          autoPublish: typeof payload.autoPublish === 'boolean' ? payload.autoPublish : undefined,
        })
        return
      }
      throw new Error(`Unsupported role-management operation: ${operation}`)
    }
    case 'choose':
      if (typeof payload.roleId === 'string') { await runtime.speak(roomId, payload.roleId); return }
      throw new Error('Choose requires roleId.')
  }
}
