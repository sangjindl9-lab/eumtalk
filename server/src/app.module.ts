import { DynamicModule, Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { ChatController } from './chat/chat.controller';
import { ChatService } from './chat/chat.service';
import { AuthGuard } from './common/auth.guard';
import { AppConfig, CONFIG } from './config';
import { Db } from './db/db';
import { GreetingsController } from './greetings/greetings.controller';
import { GreetingsService } from './greetings/greetings.service';
import { ProfileController } from './profile/profile.controller';
import { RateLimiter, RedisConn } from './realtime/redis';
import { Realtime } from './realtime/realtime';
import { SafetyController } from './safety/safety.controller';
import { SafetyService } from './safety/safety.service';
import { SystemController } from './system/system.controller';

@Module({})
export class AppModule {
  static forConfig(cfg: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [SystemController, AuthController, ProfileController, GreetingsController, ChatController, SafetyController],
      providers: [
        { provide: CONFIG, useValue: cfg },
        Db,
        RedisConn,
        RateLimiter,
        Realtime,
        AuthGuard,
        AuthService,
        ChatService,
        GreetingsService,
        SafetyService,
      ],
    };
  }
}
