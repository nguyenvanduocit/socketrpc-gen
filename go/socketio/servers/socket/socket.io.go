package socket

import (
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/servers/engine/transports"
)

type (
	TransportCtor = transports.TransportCtor

	WebSocketBuilder    = transports.WebSocketBuilder
	WebTransportBuilder = transports.WebTransportBuilder
	PollingBuilder      = transports.PollingBuilder
)

var (
	Polling      TransportCtor = &PollingBuilder{}
	WebSocket    TransportCtor = &WebSocketBuilder{}
	WebTransport TransportCtor = &WebTransportBuilder{}
)
