import type { RtpCapabilities, RtpParameters, TransportOptions } from "mediasoup-client/types";

export type BaseMessage<
  Type extends string,
  Payload = Record<string, never>,
> = {
  type: Type;
  payload: Payload;
};

export type RoomCreatedMessage = BaseMessage<"room-created", { roomId: string }>;
export type RoomNotFoundMessage = BaseMessage<"room-not-found">;
export type JoinedRoomMessage = BaseMessage<
  "joined-room",
  {
    joinRoomId: string;
    peerId: string;
    existingPeerIds: string[];
    existingProducerIds: string[];
    isHost: boolean;
    uploadToken: string;
  }
>;

export type RtpCapabilitiesMessage = BaseMessage<
  "rtpCapabilities",
  { rtpCapabilities: RtpCapabilities }
>;

export type TransportCreatedMessage = BaseMessage<
  "transportCreated",
  TransportOptions
>;
export type ConsumerTransportCreatedMessage = BaseMessage<
  "consumerTransportCreated",
  TransportOptions
>;
export type ConsumerCreatedMessage = BaseMessage<"consumer-connected">;
export type ProduceDataMessage = BaseMessage<"produce-data", { id: string }>;
export type PeerJoinedMessage = BaseMessage<"peer-joined", { peerId: string }>;
export type PeerLeftMessage = BaseMessage<
  "peer-left",
  { peerId: string; producerIds: string[] }
>;
export type NewConsumerMessage = BaseMessage<
  "newConsumer",
  {
    id: string;
    producerId: string;
    kind: "audio" | "video";
    rtpParameters: RtpParameters;
  }
>;

export type ServerToClientMessage =
  | RoomNotFoundMessage
  | RoomCreatedMessage
  | JoinedRoomMessage
  | RtpCapabilitiesMessage
  | TransportCreatedMessage
  | ConsumerCreatedMessage
  | ConsumerTransportCreatedMessage
  | ProduceDataMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | NewConsumerMessage;
