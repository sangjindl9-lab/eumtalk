import { DynamicModule, Module } from '@nestjs/common';
import { AccountController } from './account/account.controller';
import { AccountService } from './account/account.service';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { ChatController } from './chat/chat.controller';
import { ChatService } from './chat/chat.service';
import { AuthGuard } from './common/auth.guard';
import { ContentFilter } from './common/content-filter';
import { AppConfig, CONFIG } from './config';
import { Db } from './db/db';
import { GreetingsController } from './greetings/greetings.controller';
import { GreetingsService } from './greetings/greetings.service';
import { MediaController } from './media/media.controller';
import { MediaService } from './media/media.service';
import { PointsController } from './points/points.controller';
import { PointsService } from './points/points.service';
import { PurchasesService } from './points/purchases.service';
import { PostsController } from './posts/posts.controller';
import { PostsService } from './posts/posts.service';
import { PublicController } from './public/public.controller';
import { ProfileController } from './profile/profile.controller';
import { PushService } from './push/push.service';
import { RateLimiter, RedisConn } from './realtime/redis';
import { Realtime } from './realtime/realtime';
import { RoomsController } from './rooms/rooms.controller';
import { RoomsService } from './rooms/rooms.service';
import { SafetyController } from './safety/safety.controller';
import { SafetyService } from './safety/safety.service';
import { SystemController } from './system/system.controller';

@Module({})
export class AppModule {
  static forConfig(cfg: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        SystemController, AuthController, ProfileController, GreetingsController, ChatController, SafetyController,
        MediaController, RoomsController, PostsController, PointsController, AccountController, AdminController, PublicController,
      ],
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
        ContentFilter,
        MediaService,
        PushService,
        PointsService,
        PurchasesService,
        RoomsService,
        PostsService,
        AccountService,
        AdminService,
      ],
    };
  }
}
