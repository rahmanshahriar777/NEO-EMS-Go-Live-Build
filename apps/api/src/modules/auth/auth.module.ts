import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { parseDurationMs } from '../../config/configuration';
import { AuthController } from './auth.controller';
import { PasswordResetController } from './password-reset.controller';
import { OAuthController } from './oauth.controller';
import { UsersController } from './users.controller';
import { AuthService } from './auth.service';
import { UserService } from './user.service';
import { TokenService } from './token.service';
import { PasswordService } from './password.service';
import { PasswordResetService } from './password-reset.service';
import { OAuthService } from './oauth.service';
import { UsersService } from './users.service';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.accessSecret'),
        signOptions: {
          // jsonwebtoken accepts seconds as a number; the duration string is
          // validated at startup by parseDurationMs (fail fast on malformed).
          expiresIn: Math.floor(
            parseDurationMs(configService.get<string>('jwt.accessExpiration', '15m'), 'jwt.accessExpiration') / 1000,
          ),
        },
      }),
    }),
  ],
  controllers: [AuthController, PasswordResetController, OAuthController, UsersController],
  providers: [
    AuthService,
    UserService,
    TokenService,
    PasswordService,
    PasswordResetService,
    OAuthService,
    UsersService,
    JwtStrategy,
  ],
  exports: [
    AuthService,
    UserService,
    TokenService,
    PasswordService,
    PasswordResetService,
    OAuthService,
    UsersService,
  ],
})
export class AuthModule {}
