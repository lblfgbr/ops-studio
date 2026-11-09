import {z} from 'zod';

export const reviewSeverity=z.enum(['suggestion','minor','major','fatal']);
