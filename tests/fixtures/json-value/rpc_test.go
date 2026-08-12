package rpc

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
)

// These run against the freshly generated package with -race, so they assert
// properties of the emitter's output rather than of a checked-in snapshot.
//
// Everything here is about the one projection the JSON-value node introduces:
// `unknown` becomes Go's `any`, which holds every shape the wire can carry and
// is already nil-able, so it needs neither a pointer nor a named wrapper.

// everyJSONShape is the value space `unknown` promises: object, array, string,
// number, boolean and null, nested arbitrarily.
var everyJSONShape = []any{
	nil,
	"a string",
	float64(42),
	3.5,
	true,
	false,
	[]any{},
	[]any{"a", float64(1), nil, true},
	map[string]any{},
	map[string]any{
		"nested": map[string]any{"deep": []any{float64(1), map[string]any{"deeper": nil}}},
		"list":   []any{"x", "y"},
	},
}

// The projection itself: a JSON value is `any` everywhere it appears, never a
// pointer and never a generated wrapper type. Checked reflectively so the
// assertion survives any renaming of the surrounding declarations.
func TestJSONValueIsProjectedAsAny(t *testing.T) {
	anyType := reflect.TypeOf((*any)(nil)).Elem()

	value, ok := reflect.TypeOf(Mutation{}).FieldByName("Value")
	if !ok {
		t.Fatal("Mutation.Value is missing")
	}
	if value.Type != anyType {
		t.Fatalf("a required JSON field must be `any`, got %s", value.Type)
	}

	lastError, ok := reflect.TypeOf(Document{}).FieldByName("LastError")
	if !ok {
		t.Fatal("Document.LastError is missing")
	}
	// An optional JSON value stays `any`: Go's nil already spells the absence,
	// so *any would add a second, redundant way to say the same thing.
	if lastError.Type != anyType {
		t.Fatalf("an optional JSON field must stay `any`, got %s", lastError.Type)
	}

	frontmatter, ok := reflect.TypeOf(Document{}).FieldByName("Frontmatter")
	if !ok {
		t.Fatal("Document.Frontmatter is missing")
	}
	if frontmatter.Type != reflect.TypeOf(map[string]any{}) {
		t.Fatalf("Record<string, unknown> must be map[string]any, got %s", frontmatter.Type)
	}
}

// Decoding is the inbound half: Socket.IO hands the binding an already-decoded
// value, and every JSON shape has to survive the hop into an `any` unchanged.
func TestDecodeAcceptsEveryJSONShape(t *testing.T) {
	for _, shape := range everyJSONShape {
		var decoded any
		if err := rpc_decodeValue(shape, &decoded); err != nil {
			t.Fatalf("decoding %#v failed: %v", shape, err)
		}
		if !reflect.DeepEqual(decoded, shape) {
			t.Fatalf("decoding %#v produced %#v", shape, decoded)
		}
	}
}

// The same, one level in: a JSON value nested inside a generated struct.
func TestDecodeCarriesJSONValueInsideAStruct(t *testing.T) {
	for _, shape := range everyJSONShape {
		var decoded Mutation
		wire := map[string]any{"path": "notes.md", "key": "meta", "value": shape}
		if err := rpc_decodeValue(wire, &decoded); err != nil {
			t.Fatalf("decoding a mutation carrying %#v failed: %v", shape, err)
		}
		if !reflect.DeepEqual(decoded.Value, shape) {
			t.Fatalf("mutation value %#v became %#v", shape, decoded.Value)
		}
	}
}

// Nil frontmatter is Go's zero map, which encoding/json writes as null — but the
// client's type says Record<string, unknown>, which null does not satisfy. The
// generated marshaller normalizes it, and must do so on a copy.
func TestNilFrontmatterEncodesAsAnObject(t *testing.T) {
	document := Document{Path: "notes.md", Body: "text"}

	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"frontmatter":{}`) {
		t.Fatalf("a nil frontmatter must encode as {}, got %s", encoded)
	}
	if document.Frontmatter != nil {
		t.Fatal("normalization must not be visible to the handler that returned the value")
	}
}

// An optional JSON value is absent when it is nil and present otherwise. There
// is no third state: Go cannot distinguish "key omitted" from "key set to null"
// in an `any`, which is why the contract should declare a required `unknown`
// when an explicit null has to survive.
func TestOptionalJSONValueIsAbsentOnlyWhenNil(t *testing.T) {
	encoded, err := json.Marshal(Document{Path: "notes.md", Body: "text"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "lastError") {
		t.Fatalf("an absent optional JSON value must stay off the wire, got %s", encoded)
	}

	encoded, err = json.Marshal(Document{
		Path:      "notes.md",
		Body:      "text",
		LastError: map[string]any{"code": "EACCES"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"lastError":{"code":"EACCES"}`) {
		t.Fatalf("a present optional JSON value must be encoded, got %s", encoded)
	}

	// A required JSON value carries its null instead of disappearing.
	encoded, err = json.Marshal(Mutation{Path: "notes.md", Key: "title"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"value":null`) {
		t.Fatalf("a required JSON value must encode its null, got %s", encoded)
	}
}

// `__rpcError` is the protocol's discriminator in an acknowledgement slot, and a
// JSON value is the first place a contract lets user data spell it. Both sides
// read such a payload as a failure — the TypeScript client's isRpcError decides
// the same way — so a JSON value that has to survive verbatim must not carry
// that key at its top level.
func TestBrandedJSONValueIsReadAsAnError(t *testing.T) {
	branded := map[string]any{"__rpcError": true, "code": "NOPE", "message": "not an error"}
	if _, ok := rpc_decodeRpcError(branded); !ok {
		t.Fatal("a payload carrying the brand is a failure by protocol definition")
	}

	// An object that merely looks similar stays a value, and so does every shape
	// the contract actually promises.
	lookalike := map[string]any{"code": "NOPE", "message": "not an error"}
	if _, ok := rpc_decodeRpcError(lookalike); ok {
		t.Fatal("an unbranded payload must not decode as an RpcError")
	}
	for _, shape := range everyJSONShape {
		if _, ok := rpc_decodeRpcError(shape); ok {
			t.Fatalf("%#v must reach the caller as a value", shape)
		}
	}
}

// The encode preflight is what keeps `any` honest. Go will happily put a channel
// or a NaN into one, and Socket.IO's write path discards encoding failures
// without reporting them — so without this check the caller waits out its own
// timeout and never learns why.
func TestEncodePreflightRefusesNonJSONValues(t *testing.T) {
	refused := []any{
		make(chan int),
		func() {},
		math.NaN(),
		math.Inf(1),
		map[string]any{"nested": make(chan int)},
		Document{Path: "notes.md", LastError: make(chan int)},
	}

	for _, value := range refused {
		failure := rpc_ensureEncodable(value, "unencodableValue")
		if failure == nil {
			t.Fatalf("%T must be refused before it reaches the transport", value)
		}
		if failure.Code != CodeInternalError {
			t.Fatalf("got code %q, want %q", failure.Code, CodeInternalError)
		}
		if failure.Method != "unencodableValue" {
			t.Fatalf("the failure must name the call, got %q", failure.Method)
		}
		if !strings.Contains(failure.Message, "cannot encode payload") {
			t.Fatalf("the failure must say what went wrong, got %q", failure.Message)
		}
	}

	// Everything the contract actually promises passes, in every position.
	for _, shape := range everyJSONShape {
		if failure := rpc_ensureEncodable(shape, "readKey"); failure != nil {
			t.Fatalf("%#v must be encodable: %v", shape, failure)
		}
		if failure := rpc_ensureEncodable(Frontmatter{"k": shape}, "mergeFrontmatter"); failure != nil {
			t.Fatalf("frontmatter holding %#v must be encodable: %v", shape, failure)
		}
		if failure := rpc_ensureEncodable([]any{shape}, "history"); failure != nil {
			t.Fatalf("a history holding %#v must be encodable: %v", shape, failure)
		}
	}
}
