package utils

import (
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/pkg/log"
)

func Log() *log.Log {
	return log.Default()
}
