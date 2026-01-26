import { DtlsParameters, RtpCapabilities } from 'mediasoup-client/types';

export interface BaseMessage<Type extends string, Payload = {}> {
  type: Type;
  payload: Payload;
}

export interface CreateRoomMessage extends BaseMessage<'create-room'> {}
export interface JoinRoomMessage extends BaseMessage<'join-room', { joinRoomId: string }> {}
export interface GetRtpCapabilitiesMessage extends BaseMessage<'getRtpCapabilities'> {}
export interface CreateTransportMessage extends BaseMessage<'createTransport'> {}
export interface TransportConnectMessage extends BaseMessage<
  'transport-connect',
  {
    transportId: string;
    dtlsParameters: DtlsParameters;
  }
> {}

export interface TransportProduceMessage extends BaseMessage<
  'transport-produce',
  {
    transportId: string;
    kind: 'audio' | 'video';
    rtpParameters: any;
    appData?: Record<string, unknown>;
  }
> {}

export interface CreateConsumerTransportMessage extends BaseMessage<'create-consumerTransport'> {}
export interface ConsumeMessage extends BaseMessage<'consume', {
  rtpCapabilities: RtpCapabilities;
}> {}

export interface ConsumerConnectMessage extends BaseMessage<'consumer-connect', {
  transportId: string;
  dtlsParameters: DtlsParameters;
}> {}
export interface ConsumerReadyMessage extends BaseMessage<'consumer-ready', { consumerId?: string }> {}

export type ClientToServerMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | GetRtpCapabilitiesMessage
  | CreateTransportMessage
  | TransportConnectMessage
  | TransportProduceMessage
  | CreateConsumerTransportMessage
  | ConsumeMessage
  | ConsumerConnectMessage
  | ConsumerReadyMessage;