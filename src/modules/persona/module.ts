import { defineService } from '../../app/runtime/contracts.js';
import { defineModule } from '../../app/runtime/module.js';
import type { ActorContext } from '../agent/identity.js';

export interface Persona {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
}

export interface PersonaService {
  resolve(actor: ActorContext): Persona;
}

export const Personas = defineService<PersonaService>('agent.personas');

interface PersonaSpec {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly systemPrompt: string;
}

interface PersonaConfig {
  readonly defaultId: string;
  readonly profiles: readonly PersonaSpec[];
  readonly groupAssignments?: Readonly<Record<string, string>>;
  readonly c2cAssignments?: Readonly<Record<string, string>>;
}

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** 配置文件是唯一写入入口；运行期仅按平台确认的身份查找人设。 */
export class ConfiguredPersonas implements PersonaService {
  readonly #profiles = new Map<string, Persona>();
  readonly #defaultId: string;
  readonly #groups: ReadonlyMap<string, string>;
  readonly #c2c: ReadonlyMap<string, string>;

  constructor(config: PersonaConfig) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('persona 配置必须是对象');
    }
    if (!Array.isArray(config.profiles) || config.profiles.length === 0 || config.profiles.length > 32) {
      throw new Error('persona.profiles 必须包含 1–32 个人设');
    }
    for (const raw of config.profiles) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('persona.profiles 的条目必须是对象');
      }
      const id = raw.id;
      if (typeof id !== 'string' || !ID_PATTERN.test(id) || this.#profiles.has(id)) {
        throw new Error('persona.profiles 的 id 无效或重复');
      }
      const name = readText(raw.name, `persona.profiles.${id}.name`, 80);
      const description = raw.description === undefined ? ''
        : readText(raw.description, `persona.profiles.${id}.description`, 160, true);
      const systemPrompt = readText(raw.systemPrompt, `persona.profiles.${id}.systemPrompt`, 8_000);
      this.#profiles.set(id, Object.freeze({ id, name, description, systemPrompt }));
    }
    if (typeof config.defaultId !== 'string' || !this.#profiles.has(config.defaultId)) {
      throw new Error('persona.defaultId 必须引用已配置的人设');
    }
    this.#defaultId = config.defaultId;
    this.#groups = readAssignments(config.groupAssignments, 'groupAssignments', this.#profiles);
    this.#c2c = readAssignments(config.c2cAssignments, 'c2cAssignments', this.#profiles);
  }

  resolve(actor: ActorContext): Persona {
    const selected = actor.scope === 'group'
      ? actor.groupOpenid === undefined ? undefined : this.#groups.get(actor.groupOpenid)
      : this.#c2c.get(actor.actorId);
    return this.#profiles.get(selected ?? this.#defaultId)!;
  }
}

function readText(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.trim() === '')) {
    throw new Error(`${field} 必须是${allowEmpty ? '' : '非空'}字符串，最多 ${max} 字符`);
  }
  return value.trim();
}

function readAssignments(
  value: unknown, field: string, profiles: ReadonlyMap<string, Persona>,
): ReadonlyMap<string, string> {
  if (value === undefined) return new Map();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`persona.${field} 必须是对象`);
  }
  const entries = Object.entries(value);
  if (entries.length > 1_000) throw new Error(`persona.${field} 最多 1000 项`);
  const assignments = new Map<string, string>();
  for (const [openid, id] of entries) {
    if (openid.trim() === '' || openid.length > 256 || typeof id !== 'string' || !profiles.has(id)) {
      throw new Error(`persona.${field} 包含无效 OpenID 或人设 id`);
    }
    assignments.set(openid, id);
  }
  return assignments;
}

export const personaModule = defineModule<PersonaConfig>({
  name: 'persona', version: '0.1.0',
  setup(ctx) {
    const personas = new ConfiguredPersonas(ctx.config);
    ctx.provide(Personas, personas);
    ctx.logger.info('人设配置已加载');
  },
});

export default personaModule;
