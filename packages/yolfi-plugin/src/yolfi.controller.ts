import { BadRequestException, Controller, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { YolfiService } from './yolfi.service';

@Controller('payments')
export class YolfiController {
    constructor(private yolfi: YolfiService) {}

    @Post('yolfi')
    async webhook(@Headers('x-yolfi-signature') signature: string | undefined, @Req() req: Request) {
        if (!Buffer.isBuffer(req.body)) throw new BadRequestException('Yolfi requires the raw JSON body');
        await this.yolfi.handleWebhook(req.body, signature);
        return { received: true };
    }
}
