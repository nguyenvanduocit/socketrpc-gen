package types

import (
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/pkg/webtransport"
	wt "github.com/quic-go/webtransport-go"
)

type WebTransportConn struct {
	EventEmitter

	*webtransport.Conn
}

func (t *WebTransportConn) CloseWithError(code wt.SessionErrorCode, msg string) error {
	defer t.Emit("close")
	return t.Conn.CloseWithError(code, msg)
}
