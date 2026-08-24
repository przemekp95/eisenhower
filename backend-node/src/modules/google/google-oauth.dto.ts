import { IsString } from 'class-validator';

export class GoogleOAuthStartDto {
  @IsString()
  returnPath!: string;
}
