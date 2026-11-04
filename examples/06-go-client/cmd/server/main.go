// Command server is the coordinator: it serves the /worker namespace, admits a
// worker only with the shared token, and hands every worker that registers one
// task to run.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"time"

	sioserver "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/servers/socket"

	"example.com/coordinator/wire"
)

// session answers one worker connection. It implements the generated
// wire.ServerHandler and calls back into the worker through the generated
// wire.Client.
type session struct {
	client *wire.Client
}

func (s *session) HandleRegister(ctx context.Context, worker wire.Worker) (wire.Registration, error) {
	if worker.Name == "" {
		return wire.Registration{}, wire.NewRpcError(wire.CodeInvalidArgument, "worker name is required", "", nil)
	}
	log.Printf("registered %s (capacity %v)", worker.Name, worker.Capacity)

	// ctx belongs to the connection, not to this call, so it outlives the reply
	// and is cancelled when the worker goes away.
	go s.dispatch(ctx, wire.Task{ID: "task-" + worker.Name, Prompt: "summarize the release notes"})
	return wire.Registration{WorkerID: worker.Name, Pending: 1}, nil
}

func (s *session) HandleProgress(_ context.Context, taskID string, percent float64) error {
	log.Printf("%s: %v%%", taskID, percent)
	return nil
}

func (s *session) dispatch(ctx context.Context, task wire.Task) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	result, err := s.client.CallRunTask(ctx, task)
	var failure *wire.RpcError
	if errors.As(err, &failure) {
		log.Printf("%s failed: %s: %s", task.ID, failure.Code, failure.Message)
		return
	}
	log.Printf("%s done: %s", result.TaskID, result.Output)
}

func serve(raw *sioserver.Socket) {
	client, err := wire.NewClient(raw, nil)
	if err != nil {
		log.Printf("new client: %v", err)
		return
	}
	binding, err := wire.BindServer(raw, &session{client: client})
	if err != nil {
		client.Dispose()
		log.Printf("bind server: %v", err)
		return
	}
	go func() {
		<-binding.Context().Done()
		client.Dispose()
	}()
}

func main() {
	addr := flag.String("addr", "127.0.0.1:3000", "address to listen on")
	token := flag.String("token", "worker-secret", "token a worker must present in its auth payload")
	flag.Parse()

	io := sioserver.NewServer(nil, nil)
	workers := io.Of("/worker", nil)
	// A refused handshake reaches the worker's Dial as an error carrying this message.
	workers.Use(func(raw *sioserver.Socket, next func(*sioserver.ExtendedError)) {
		if presented, _ := raw.Handshake().Auth["token"].(string); presented != *token {
			next(sioserver.NewExtendedError("unauthorized: unknown worker token", nil))
			return
		}
		next(nil)
	})
	if err := workers.On("connection", func(args ...any) {
		if raw, ok := args[0].(*sioserver.Socket); ok {
			serve(raw)
		}
	}); err != nil {
		log.Fatalf("register connection: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/socket.io/", io.ServeHandler(nil))
	log.Printf("coordinator listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
