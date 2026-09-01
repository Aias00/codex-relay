package tailcatmobile

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/logger"
)

type transport struct {
	cachePath  string
	client     *tailcat.Client
	listener   net.Listener
	targetPort uint16
	token      string
}

const (
	maxDERPMapCacheBytes        = 8 << 20
	maxDERPMapCacheFileBytes    = 12 << 20
	maxDERPMapCacheETagBytes    = 4096
	maxDERPMapCacheFutureOffset = 5 * time.Minute
)

type diskDERPMapCache struct {
	directory string
}

type diskDERPMapEntry struct {
	Data     []byte    `json:"data"`
	ETag     string    `json:"etag,omitempty"`
	StoredAt time.Time `json:"storedAt"`
	URL      string    `json:"url"`
}

var state struct {
	sync.Mutex
	current *transport
}

// Start creates or reuses the process-local loopback proxy for one Tailcat server.
func Start(token string, targetPort int, cachePath string) (string, error) {
	if token == "" {
		return "", errors.New("tailcat token is empty")
	}
	if targetPort < 1 || targetPort > 65535 {
		return "", errors.New("target port is invalid")
	}
	var err error
	cachePath, err = normalizeCachePath(cachePath)
	if err != nil {
		return "", err
	}

	state.Lock()
	if current := state.current; current != nil && current.token == token && current.targetPort == uint16(targetPort) && current.cachePath == cachePath {
		endpoint := "http://" + current.listener.Addr().String()
		state.Unlock()
		return endpoint, nil
	}
	state.Unlock()

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("listen: %w", err)
	}
	client := tailcat.NewClient(tailcat.ConnBlob(token))
	client.Logf = logger.Discard
	if cachePath != "" {
		client.DERPMapCache = newDiskDERPMapCache(cachePath)
	}
	next := &transport{
		cachePath:  cachePath,
		client:     client,
		listener:   listener,
		targetPort: uint16(targetPort),
		token:      token,
	}

	state.Lock()
	previous := state.current
	state.current = next
	state.Unlock()
	if previous != nil {
		previous.close()
	}
	go next.serve()
	return "http://" + listener.Addr().String(), nil
}

func normalizeCachePath(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	if len(path) > 1024 || !filepath.IsAbs(path) {
		return "", errors.New("cache path must be an absolute path")
	}
	path = filepath.Clean(path)
	if path == string(filepath.Separator) {
		return "", errors.New("cache path cannot be the filesystem root")
	}
	return path, nil
}

func newDiskDERPMapCache(directory string) *diskDERPMapCache {
	return &diskDERPMapCache{directory: directory}
}

func (c *diskDERPMapCache) Get(url string) ([]byte, string, time.Time, bool) {
	file, err := os.Open(c.entryPath(url))
	if err != nil {
		return nil, "", time.Time{}, false
	}
	payload, readErr := io.ReadAll(io.LimitReader(file, maxDERPMapCacheFileBytes+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || len(payload) > maxDERPMapCacheFileBytes {
		c.remove(url)
		return nil, "", time.Time{}, false
	}
	var entry diskDERPMapEntry
	if json.Unmarshal(payload, &entry) != nil ||
		entry.URL != url ||
		len(entry.Data) == 0 ||
		len(entry.Data) > maxDERPMapCacheBytes ||
		len(entry.ETag) > maxDERPMapCacheETagBytes ||
		entry.StoredAt.IsZero() ||
		entry.StoredAt.After(time.Now().Add(maxDERPMapCacheFutureOffset)) {
		c.remove(url)
		return nil, "", time.Time{}, false
	}
	return append([]byte(nil), entry.Data...), entry.ETag, entry.StoredAt, true
}

func (c *diskDERPMapCache) Put(url string, data []byte, etag string) error {
	if url == "" || len(url) > 4096 {
		return errors.New("DERP map URL is invalid")
	}
	if len(data) == 0 || len(data) > maxDERPMapCacheBytes {
		return errors.New("DERP map exceeds the cache size limit")
	}
	if len(etag) > maxDERPMapCacheETagBytes {
		return errors.New("DERP map ETag exceeds the cache size limit")
	}
	payload, err := json.Marshal(diskDERPMapEntry{
		Data:     data,
		ETag:     etag,
		StoredAt: time.Now(),
		URL:      url,
	})
	if err != nil || len(payload) > maxDERPMapCacheFileBytes {
		return errors.New("DERP map cache entry is invalid")
	}
	if err := os.MkdirAll(c.directory, 0o700); err != nil {
		return err
	}
	_ = os.Chmod(c.directory, 0o700)
	temporary, err := os.CreateTemp(c.directory, ".derp-map-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, c.entryPath(url)); err != nil {
		return err
	}
	return os.Chmod(c.entryPath(url), 0o600)
}

func (c *diskDERPMapCache) entryPath(url string) string {
	digest := sha256.Sum256([]byte(url))
	return filepath.Join(c.directory, fmt.Sprintf("%x.json", digest))
}

func (c *diskDERPMapCache) remove(url string) {
	_ = os.Remove(c.entryPath(url))
}

// Stop closes the loopback listener, active proxy connections, and Tailcat client.
func Stop() {
	state.Lock()
	current := state.current
	state.current = nil
	state.Unlock()
	if current != nil {
		current.close()
	}
}

// Path probes the active Tailcat route without exposing endpoint or DERP details.
func Path(timeoutMillis int) string {
	state.Lock()
	current := state.current
	state.Unlock()
	if current == nil {
		return "stopped"
	}
	if timeoutMillis < 1 {
		timeoutMillis = 1500
	} else if timeoutMillis > 10000 {
		timeoutMillis = 10000
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMillis)*time.Millisecond)
	defer cancel()
	result, err := current.client.DiscoPing(ctx)
	if err != nil {
		return "unknown"
	}
	return connectionPath(result.Endpoint, result.DERPRegionID)
}

func connectionPath(endpoint string, derpRegionID int) string {
	if endpoint != "" {
		return "direct"
	}
	if derpRegionID > 0 {
		return "derp"
	}
	return "unknown"
}

func (t *transport) serve() {
	for {
		local, err := t.listener.Accept()
		if err != nil {
			return
		}
		go t.proxy(local)
	}
}

func (t *transport) proxy(local net.Conn) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	remote, err := t.client.DialTCPPort(ctx, t.targetPort)
	if err != nil {
		local.Close()
		return
	}
	tailcat.ProxyConns(local, remote)
}

func (t *transport) close() {
	t.listener.Close()
	t.client.Close()
}
