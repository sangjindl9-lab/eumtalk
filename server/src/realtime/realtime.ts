import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { sha256 } from '../common/crypto';
import { Db } from '../db/db';
import { RedisConn } from './redis';

export interface RtEvent {
  type: string;
  data: unknown;
}

interface Client {
  ws: WebSocket;
  userId: string | null;
  alive: boolean;
}

const CHANNEL = 'eumtalk:events';
const AUTH_TIMEOUT_MS = 8000;
const PING_MS = 25000;

/**
 * 실시간 이벤트 전달.
 * 메시지 원본은 항상 PostgreSQL에 먼저 저장되고, 여기서는 "새 소식이 있다"를 접속 중인 단말에 밀어줄 뿐이다.
 * 단말이 끊겨 이벤트를 놓쳐도 재연결 후 REST 동기화(afterSeq)로 빠진 메시지를 받아온다.
 */
@Injectable()
export class Realtime implements OnModuleDestroy {
  private readonly log = new Logger('Realtime');
  private wss: WebSocketServer | null = null;
  private readonly byUser = new Map<string, Set<Client>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(Db) private readonly db: Db, @Inject(RedisConn) private readonly redis: RedisConn) {
    if (this.redis.sub) {
      this.redis.sub.subscribe(CHANNEL).catch((e) => this.log.warn(`subscribe 실패: ${e.message}`));
      this.redis.sub.on('message', (_ch, raw) => {
        try {
          const { userIds, event } = JSON.parse(raw);
          this.deliver(userIds, event);
        } catch {
          /* 무시 */
        }
      });
    }
  }

  attach(server: HttpServer) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    server.on('upgrade', (req: IncomingMessage, socket, head) => {
      const path = (req.url || '').split('?')[0];
      if (path !== '/v1/ws') {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
    this.timer = setInterval(() => this.sweep(), PING_MS);
  }

  private onConnection(ws: WebSocket) {
    const client: Client = { ws, userId: null, alive: true };
    const authTimer = setTimeout(() => {
      if (!client.userId) ws.close(4401, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    ws.on('pong', () => (client.alive = true));
    ws.on('message', async (raw) => {
      client.alive = true;
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg?.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', data: { t: Date.now() } }));
        return;
      }
      // 토큰은 주소(쿼리)가 아니라 첫 프레임으로 받는다. 접속 로그에 남지 않게 하기 위함이다.
      if (msg?.type === 'auth' && !client.userId && typeof msg.token === 'string') {
        const row = await this.db
          .one<{ user_id: string }>(
            `SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND u.status = 'active'`,
            [sha256(msg.token)],
          )
          .catch(() => null);
        if (!row) {
          ws.close(4401, 'unauthorized');
          return;
        }
        clearTimeout(authTimer);
        client.userId = row.user_id;
        let set = this.byUser.get(row.user_id);
        if (!set) this.byUser.set(row.user_id, (set = new Set()));
        set.add(client);
        this.markOnline(row.user_id);
        ws.send(JSON.stringify({ type: 'ready', data: { userId: row.user_id } }));
      }
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (client.userId) {
        const set = this.byUser.get(client.userId);
        set?.delete(client);
        if (set && set.size === 0) this.byUser.delete(client.userId);
      }
    });
    ws.on('error', () => ws.terminate());
  }

  private sweep() {
    for (const [userId, set] of this.byUser) {
      for (const c of set) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        try {
          c.ws.ping();
        } catch {
          /* 무시 */
        }
      }
      this.markOnline(userId);
    }
  }

  /** 접속 상태는 Redis에 짧은 수명으로 둔다(2단계 푸시 발송 여부 판단에 사용). */
  private markOnline(userId: string) {
    this.redis.client?.set(`online:${userId}`, '1', 'EX', 60).catch(() => undefined);
  }

  isLocallyConnected(userId: string) {
    return (this.byUser.get(userId)?.size || 0) > 0;
  }

  /** 세션 폐기·정지 시 해당 회원의 소켓을 끊는다. */
  disconnectUser(userId: string) {
    this.emit([userId], { type: 'session.revoked', data: {} });
    setTimeout(() => this.byUser.get(userId)?.forEach((c) => c.ws.close(4401, 'revoked')), 200);
  }

  emit(userIds: string[], event: RtEvent) {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return;
    if (this.redis.client) {
      this.redis.client.publish(CHANNEL, JSON.stringify({ userIds: ids, event })).catch(() => this.deliver(ids, event));
    } else {
      this.deliver(ids, event);
    }
  }

  private deliver(userIds: string[], event: RtEvent) {
    const payload = JSON.stringify(event);
    for (const id of userIds) {
      this.byUser.get(id)?.forEach((c) => {
        if (c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
      });
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.wss?.clients.forEach((c) => c.terminate());
    this.wss?.close();
  }
}
