import { Micro, MicroPlugin } from '@pestras/micro';
import * as Nats from 'ts-nats';

export interface NatsMsg<T = any> extends Nats.Msg {
  data?: T;
}

export interface NatsEvents {
  onNatsConnected?: (client?: Nats.Client) => void;
}

/**
 * Nats Subject config interface
 */
export interface SubjectConfig {
  hooks?: string[];
  dataQuota?: number;
  payload?: Nats.Payload;
  options?: Nats.SubscriptionOptions;
  meta?: any;
}

export interface SubjectFullConfig extends SubjectConfig {
  key?: string;
  service?: any;
}

/**
 * Nats subjects repo that will hold all defined subjects
 */
let serviceSubjects: { [key: string]: SubjectFullConfig } = {};

/**
 * Nats subject decorator
 * accepts subject configurations
 * @param config 
 */
export function SUBJECT(subject: string, config: SubjectConfig = {}) {
  return (target: any, key: string) => {
    serviceSubjects[subject] = {
      service: target.constructor,
      options: config.options || {},
      hooks: config.hooks || [],
      dataQuota: config.dataQuota || 1024 * 100,
      payload: config.payload || Nats.Payload.JSON,
      key
    }
  };
}

export class MicroNats extends MicroPlugin {
  private _subs = new Map<string, Nats.Subscription>();
  private _client: Nats.Client;
  healthy = true;

  constructor(private _conf: string | number | Nats.NatsConnectionOptions = "localhost:4222") {
    super();
  }

  get client() { return this._client; }
  get subs() { return this._subs; }

  async init() {
    Micro.logger.info('initializing nats server connection');
    this._client = await Nats.connect(this._conf);
    Micro.logger.info('connected to nats server successfully');

    if (typeof Micro.service.onNatsConnected === "function")
      Micro.service.onNatsConnected(this._client);

    for (let service of Micro.subServices)
      if (typeof service.onNatsConnected === "function")
        service.onNatsConnected(this._client);

    for (let subject in serviceSubjects) {
      let subjectConf = serviceSubjects[subject];
      let currentService = Micro.getCurrentService(subjectConf.service) || Micro.service;

      if (typeof Micro.service[subjectConf.key] !== "function") continue;

      Micro.logger.info('subscribing to subject: ' + subject);
      let sub = await this._client.subscribe(subject, async (err, msg) => {
        Micro.logger.info(`subject called: ${subject}`);

        if (err) return Micro.logger.error(err, `subject: ${subject}, method: ${subjectConf.key}`);

        if (subjectConf.dataQuota && subjectConf.dataQuota < msg.size) {
          if (msg.reply) this._client.publish(msg.reply, 'msg body quota exceeded');
          return Micro.logger.warn('msg body quota exceeded');
        }

        if (subjectConf.hooks && subjectConf.hooks.length > 0) {
          let currHook: string;

          try {
            for (let hook of subjectConf.hooks) {
              currHook = hook;

              if (currentService[hook] === undefined && Micro.service[hook] === undefined) return Micro.logger.warn(`Hook not found: ${hook}!`);
              else if (typeof currentService[hook] !== 'function' && typeof Micro.service[hook] !== 'function') return Micro.logger.warn(`invalid hook type: ${hook}!`);

              let ret = currentService[hook] ? currentService[hook](this._client, msg, subjectConf.key, subjectConf.meta) : Micro.service[hook](this._client, msg, subjectConf.key, subjectConf.meta);
              if (ret) {
                if (typeof ret.then === "function") {
                  let passed = await ret;

                  if (!passed) return Micro.logger.info(`subject ${msg.subject} ended from hook: ${hook}`);
                }

              } else return Micro.logger.info(`subject ${msg.subject} ended from hook: ${hook}`);
            }
          } catch (e) {
            if (msg.reply) this, this._client.publish(msg.reply, { error: { msg: 'hook unhandled error' + currHook } });
            return Micro.logger.error(e);
          }
        }

        try {
          let ret = currentService[subjectConf.key](this._client, msg, subjectConf.meta);
          if (ret && typeof ret.then === "function") await ret;
          Micro.logger.info(`subject ${msg.subject} ended`);
        } catch (e) { Micro.logger.error(e, `subject: ${subject}, method: ${subjectConf.key}`); }

      }, subjectConf.options);

      this._subs.set(subject, sub);
    }

    this.ready = true;
    this.live = true;
  }
}