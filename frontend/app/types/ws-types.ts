import { TransportOptions } from 'mediasoup-client/types';

export interface BaseMessage<Type extends string, Payload = {}> {
  type: Type;
  payload: Payload;
}

export interface RoomCreatedMessage extends BaseMessage<'room-created', { roomId: string }> {}
export interface RoomNotFoundMessage extends BaseMessage<'room-not-found'>{};
export interface JoinedRoomMessage extends BaseMessage<
  'joined-room',
  {
    joinRoomId: string;
    peerId: string;
    existingPeerIds: string[];
  }
> {}

export interface RtpCapabilitiesMessage extends BaseMessage<
  'rtpCapabilities',
  { rtpCapabilities: any }
> {}

export interface TransportCreatedMessage extends BaseMessage<
  'transportCreated',
  TransportOptions
> {}
export interface ConsumerTransportCreatedMessage extends BaseMessage<
  'consumerTransportCreated',
  TransportOptions
> {}
export interface ProduceDataMessage extends BaseMessage<'produce-data', { id: string }> {}
export interface NewConsumerMessage extends BaseMessage<
  'newConsumer',
  {
    id: string;
    producerId: string;
    kind: 'audio' | 'video';
    rtpParameters: any;
  }
> {}
export type ServerToClientMessage =
  | RoomNotFoundMessage
  | RoomCreatedMessage
  | JoinedRoomMessage
  | RtpCapabilitiesMessage
  | TransportCreatedMessage
  | ConsumerTransportCreatedMessage
  | ProduceDataMessage
  | NewConsumerMessage;
