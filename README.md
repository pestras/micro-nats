# Pestras Micro Nats

Pestras microservice plugin for nats messaging server support.

## install

```bash
npm i @pestras/micro @pestras/micro-nats
```

## Template

```bash
$ git clone https://github.com/pestras/pestras-micro-template
```

## Plug In

```ts
import { SERVICE, Micro } from '@pestras/micro';
import { MicroNats } from '@pestras/micro-nats;

Micro.plugin(new MicroNats());

@SERVICE()
class test {}

Micro.start(Test);
```

**MicroRouter** class accepts a single optional argument **connection**.

Name        | Type     | Defualt         | Description
----        | -----    | ------          | -----
connection  | string \| number \| NatsConnectionOptions | 'localhost:42222' | see [Nats Docs](https://docs.nats.io/)

## SUBJECT DECORATOR

Used to subscribe to nats server pulished subjects, and also accepts a subject string as a first argument and an optional config object.

Name | Type | Default | Description
--- | --- | --- | ---
hooks | string[] | [] | hooks methods that should be called before the route handler
dataQuota | number | 1024 * 100 | Subject msg data size limit
payload | Nats.Payload | Payload.JSON | see [Nats Docs](https://docs.nats.io/)
options | Nats.SubscriptionOptions | null | see [Nats Docs](https://docs.nats.io/)
meta | any | extra details that will be passed to the handler, useful for multiple subjects

```ts
import { SERVICE, Micro } from '@pestras/micro';
import { SUBJECT, NATS_HOOK, NatsMsg } from '@pestras/micro-nats';
import { Client, Payload} from 'ts-nats';

Micro.plugin(new MicroNats());

@SERVICE({ workers: 3 })
class Email {

  // hooks works with subjects as well
  // arguments are swaped with (nats: Nats.Client, msg: NatsMsg, handlerName: string - name of the subject handler method that called the hook)
  @NATS_HOOK()
  async auth(nats: Client, msg: NatsMsg, handlerName: string) {
    // if hook failed its purpose should check for msg reply if exists and return false
    if (msg.reply) {
      nats.publish(msg.replay, { error: 'some error' })
      return false
    }

    // otherwise
    return true;
  }

  @SUBJECT('user.insert', {
    hooks: ['auth'],
    options: { queue: 'emailServiceWorker' }
  })
  sendActivationEmail(nats: Client, msg: NatsMsg) {
    let auth = msg.data.auth;
  }
```

Hooks must return or resolve (async) to true on success or false on failure.

### Multible Subjects

Multible subjects can be used on the same handler.

```ts
import { SERVICE, Micro } from '@pestras/micro';
import { SUBJECT, NatsMsg } from '@pestras/micro-nats';
import { Client, Payload} from 'ts-nats';

Micro.plugin(new MicroNats());

interface MsgInput { id: string; email: string }

@SERVICE()
class Email {

  @SUBJECT('emails.new', { meta: { template: "newEmail" } })
  @SUBJECT('emails.reactivate', { meta: { template: "reactivateEmail" } })
  sendActivataionEmail(client: Client, msg: NatsMsg<MsgInput>, meta: any) {
    // send email
    let emailTemplate = meta.template;
  }
}
```

# Sub Services

```ts
// comments.service.ts
import { SUBJECT, NATS_HOOK, NatsEvents } from '@pestras/micro-nats';
import { Client, Payload} from 'ts-nats';

export class Comments implements NatsEvents {

  onNatsConnected(client: Client) {
    // ...
  }
  
  @NATS_HOOK()
  validate(client: Client, msg: NatsMsg, handlerName: string) { return true }
  
  @SUBJECT('newComment', {
    // auth hook from the main service
    // validate hook from the local service (sub service)
    hooks: ['auth', 'validate']
  })
  create(client: Client, msg: NatsMsg) {
    
  }
}
```

```ts
// main.ts
import { Micro, SERVICE } from '@pestras/micro';
import { SUBJECT, NATS_HOOK } from '@pestras/micro-nats';
import { Client, Payload} from 'ts-nats';

Micro.plugin(new MicroRouter());

@SERVICE()
class Articles {

  onInit() {    
    Micro.store.someSharedValue = "shared value";
  }

  @NATS_HOOK()
  async auth(client: Client, msg: NatsMsg, handlerName: string) {
    return true;
  }

  @NATS_HOOK()
  validate(client: Client, msg: NatsMsg, handlerName: string) {
    return true;
  }

  @SUBJECT('newArticle', {
    // both hooks from the main service
    hooks: ['auth', 'validate']
  })
  create(client: Client, msg: NatsMsg) {
    
  }
}

// pass sub services as an array to the second argument of Micro.start method
Micro.start(Articles, [Comments]);
```

* Local hooks has the priority over main service hooks.
* Subservices have their own lifecycle events.

## lifecycle Events

### onNatsConnected

Called whenever nats driver has a successfull connection

```ts
import { SERVICE, Micro } from '@pestras/micro';
import { SUBJECT, NatsMsg, NatsEvents } from '@pestras/micro-nats';
import { Client, Payload} from 'ts-nats';

Micro.plugin(new MicroNats());

interface MsgInput { id: string; email: string }

@SERVICE()
class Email implements NatsEvents {

  onNatsConnected(client: Client) {
    // ...
  }

  @SUBJECT('emails.new')
  sendActivataionEmail(client: Client, msg: NatsMsg<MsgInput>) {
    // send email
  }
}
```

Thank you