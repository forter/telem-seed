import { Kafka, Consumer } from 'kafkajs';
import type { EachMessagePayload } from 'kafkajs';
import { findDistinctTopics, findByTopic } from '../db/subscribers';
import { deliver } from '../delivery/deliver';
import { logAttempt } from '../db/deliveryLog';
import { isTopicBlocked } from '../flags';

let consumer: Consumer | null = null;
const subscribedTopics = new Set<string>();
let isRunning = false;

// Serialise all subscribe calls so concurrent POSTs can't race stop()/run().
let subscribeLock = Promise.resolve();

export async function handleMessage({ topic, partition, message }: EachMessagePayload): Promise<void> {
  const messageKey = message.key ? message.key.toString() : null;
  const payload = message.value ? message.value.toString() : '';

  const subscribers = await findByTopic(topic);
  if (subscribers.length > 0) {
    const ops = await isTopicBlocked(topic)
      ? subscribers.map((sub) =>
          logAttempt({ subscriber_id: sub.id, message_key: messageKey, payload, attempt_number: 1, status: 'blocked', http_status: null, error_message: null })
        )
      : subscribers.map((sub) => deliver(sub, topic, messageKey, payload));

    const results = await Promise.allSettled(ops);

    // If any operation threw unexpectedly (e.g. DB down while logging), propagate to
    // prevent offset commit — KafkaJS will retry the message (at-least-once).
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
  }

  await consumer!.commitOffsets([
    { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
  ]);
}

async function startRunning(): Promise<void> {
  isRunning = true;
  await consumer!.run({ autoCommit: false, eachMessage: handleMessage });
}

async function doSubscribeToTopic(topic: string): Promise<void> {
  if (!consumer || subscribedTopics.has(topic)) return;

  if (isRunning) {
    await consumer.stop();
    isRunning = false;
  }

  await consumer.subscribe({ topic, fromBeginning: false });
  subscribedTopics.add(topic);
  console.log(`Kafka consumer: subscribed to new topic "${topic}"`);

  await startRunning();
}

export function subscribeToTopic(topic: string): Promise<void> {
  const next = subscribeLock.then(() => doSubscribeToTopic(topic));
  // Swallow errors in the lock chain so a failed subscribe doesn't block future ones.
  subscribeLock = next.catch(() => {});
  return next;
}

export async function stopConsumer(): Promise<void> {
  if (consumer) {
    if (isRunning) {
      await consumer.stop();
      isRunning = false;
    }
    await consumer.disconnect();
    consumer = null;
  }
}

let _connectedOverride: boolean | null = null;

export function isConsumerConnected(): boolean {
  if (_connectedOverride !== null) return _connectedOverride;
  return consumer !== null;
}

export function __overrideConsumerConnectedForTest(value: boolean | null): void {
  _connectedOverride = value;
}

export async function startConsumer(): Promise<void> {
  const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');

  const kafka = new Kafka({ clientId: 'webhooks-platform', brokers });
  consumer = kafka.consumer({ groupId: 'webhooks-platform' });
  await consumer.connect();

  const topics = await findDistinctTopics();

  if (topics.length === 0) {
    console.log('Kafka consumer: connected, waiting for first subscriber');
    return;
  }

  for (const topic of topics) {
    await consumer.subscribe({ topic, fromBeginning: false });
    subscribedTopics.add(topic);
  }

  console.log(`Kafka consumer: subscribing to topics: ${topics.join(', ')}`);
  await startRunning();
  console.log('Kafka consumer running');
}
