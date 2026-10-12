import { config } from './config';
import { localSealer, type Sealer } from './crypto';

let instance: Sealer | undefined;

/** The process sealer. A KMS-backed implementation replaces localSealer for shared environments. */
export const sealer = () => (instance ??= localSealer(config().RESOLVE_ENCRYPTION_KEY));
