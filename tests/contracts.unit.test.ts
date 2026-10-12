import {test,expect} from 'vitest';
import {healthSchema} from '../packages/contracts/src';
test('rejects unsupported service contracts',()=>{expect(healthSchema.safeParse({service:'resolve-api',version:'2',status:'ok'}).success).toBe(false);});
