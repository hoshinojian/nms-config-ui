BIN := bin/nms-config-ui

.PHONY: build test lint fmt clean

build:
	go build -o $(BIN) .

test:
	go test ./...

# 与 CI 同口径：gofmt 非空即红 + vet
lint:
	@out=$$(gofmt -l .); if [ -n "$$out" ]; then echo "gofmt 未格式化："; echo "$$out"; exit 1; fi
	go vet ./...

fmt:
	gofmt -w .

clean:
	rm -rf bin
