import { Micro, MicroPlugin } from '@pestras/micro';
import { connect, ConnectionOptions, NatsConnection, Msg, JSONCodec, SubscriptionOptions, Subscription, MsgHdrs, PublishOptions } from 'nats';

export class NatsMsg<T = any> implements Msg {
  public readonly jc = JSONCodec<T>();
  readonly sid: number;
  readonly subject: string;
  readonly reply: string;
  readonly data: Uint8Array;
  readonly headers: MsgHdrs;
  readonly respond: (data?: Uint8Array, opts?: PublishOptions) => boolean;
  json: T;

  constructor(msg: Msg) {
    this.sid = msg.sid;
    this.subject = msg.subject;
    this.reply = msg.reply;
    this.data = msg.data;
    this.headers = msg.headers;
    this.respond = msg.respond;
    this.json = this.jc.decode(msg.data);
  }
}

export interface NatsEvents {
  onNatsConnected?: (client?: NatsConnection) => void;
}

/**
 * Nats Subject config interface
 */
export interface SubjectConfig {
  hooks?: string[];
  dataQuota?: number;
  options?: SubscriptionOptions;
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
      key
    }
  };
}

export class MicroNats extends MicroPlugin {
  private _subs = new Map<string, Subscription>();
  private _client: NatsConnection;
  healthy = true;

  constructor(private _conf: ConnectionOptions = { servers: "localhost:4222" }) {
    super();
  }

  get client() { return this._client; }
  get subs() { return this._subs; }

  onExit() {
    !!this._client && this._client.drain().then(() => this.client.close()).catch(() => this.client.close());
  }

  async init() {
    Micro.logger.info('initializing nats server connection');
    this._client = await connect(this._conf);
    Micro.logger.info('connected to nats server successfully');

    if (typeof Micro.service.onNatsConnected === "function")
      Micro.service.onNatsConnected(this._client);

    for (let service of Micro.subServices)
      if (typeof service.onNatsConnected === "function")
        service.onNatsConnected(this._client);

    for (let subject in serviceSubjects) {
      let subjectConf = serviceSubjects[subject];
      let currentService = Micro.getCurrentService(subjectConf.service) || Micro.service;

      if (typeof Micro.service[subjectConf.key] !== "function")
        continue;

      Micro.logger.info('subscribing to subject: ' + subject);
      let sub = await this._client.subscribe(subject, subjectConf.options);

      for await (let msg of sub) {
        Micro.logger.info(`subject called: ${msg.subject}`);
        let natsMsg = new NatsMsg(msg);

        // TODO: Check for msg error
        if (subjectConf.dataQuota && subjectConf.dataQuota < sub.getProcessed()) {
          msg.respond(natsMsg.jc.encode('msg body quota exceeded'));
          return Micro.logger.warn('msg body quota exceeded');
        }

        if (subjectConf.hooks && subjectConf.hooks.length > 0) {
          let currHook: string;

          try {
            for (let hook of subjectConf.hooks) {
              currHook = hook;

              if (currentService[hook] === undefined && Micro.service[hook] === undefined) {
                natsMsg.respond(natsMsg.jc.encode({ error: { msg: 'hook unhandled error' + currHook } }));
                return Micro.logger.warn(`Hook not found: ${hook}!`);

              } else if (typeof currentService[hook] !== 'function' && typeof Micro.service[hook] !== 'function') {
                natsMsg.respond(natsMsg.jc.encode({ error: { msg: 'hook unhandled error' + currHook } }));
                return Micro.logger.warn(`invalid hook type: ${hook}!`);
              }

              let ret = currentService[hook]
                ? currentService[hook](this._client, natsMsg, subjectConf.key, subjectConf.meta)
                : Micro.service[hook](this._client, natsMsg, subjectConf.key, subjectConf.meta);

              if (ret) {
                if (typeof ret.then === "function") {
                  let passed = await ret;

                  if (!passed) {
                    natsMsg.respond(natsMsg.jc.encode({ error: { msg: 'blocked by hook: ' + currHook } }));
                    return Micro.logger.info(`subject ${msg.subject} blocked by hook: ${hook}`);
                  }
                }

              } else {
                natsMsg.respond(natsMsg.jc.encode({ error: { msg: 'blocked by hook: ' + currHook } }));
                return Micro.logger.info(`subject ${msg.subject} blocked by hook: ${hook}`);
              }
            }
          } catch (e) {
            natsMsg.respond(natsMsg.jc.encode({ error: { msg: 'hook unhandled error' + currHook } }));
            return Micro.logger.error(e);
          }
        }

        try {
          let ret = currentService[subjectConf.key](this._client, natsMsg, subjectConf.meta);

          if (ret && typeof ret.then === "function")
            await ret;

          Micro.logger.info(`subject ${msg.subject} ended`);

        } catch (e) {
          natsMsg.respond(natsMsg.jc.encode({ error: { msg: 'unknownError' } }));
          Micro.logger.error(e, `subject: ${subject}, method: ${subjectConf.key}`);
        }
      }

      this._subs.set(subject, sub);
    }

    this.ready = true;
    this.live = true;
  }
}