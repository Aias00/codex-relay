package tailcatmobile

import (
	"bytes"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestStartIsIdempotentForTheSameRoute(t *testing.T) {
	t.Cleanup(Stop)
	cachePath := t.TempDir()
	first, err := Start("not-dialed-test-token", 8788, cachePath)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Start("not-dialed-test-token", 8788, cachePath)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("Start returned different endpoints: %q != %q", first, second)
	}
	parsed, err := url.Parse(first)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" {
		t.Fatalf("Start returned non-loopback endpoint %q", first)
	}
}

func TestStartValidatesInputs(t *testing.T) {
	if _, err := Start("", 8788, ""); err == nil {
		t.Fatal("Start accepted an empty token")
	}
	if _, err := Start("token", 0, ""); err == nil {
		t.Fatal("Start accepted an invalid port")
	}
	if _, err := Start("token", 8788, "relative/cache"); err == nil {
		t.Fatal("Start accepted a relative cache path")
	}
}

func TestConnectionPathDoesNotExposeEndpointOrRegion(t *testing.T) {
	tests := []struct {
		name         string
		endpoint     string
		derpRegionID int
		want         string
	}{
		{name: "direct", endpoint: "192.0.2.10:41641", want: "direct"},
		{name: "derp", derpRegionID: 17, want: "derp"},
		{name: "unknown", want: "unknown"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := connectionPath(tt.endpoint, tt.derpRegionID); got != tt.want {
				t.Fatalf("connectionPath() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestDiskDERPMapCachePersistsAcrossInstances(t *testing.T) {
	directory := t.TempDir()
	first := newDiskDERPMapCache(directory)
	url := "https://tailcat.dev/derpmap.json"
	data := []byte(`{"Regions":{"17":{"RegionID":17}}}`)
	if err := first.Put(url, data, `"etag-1"`); err != nil {
		t.Fatal(err)
	}

	stored, etag, storedAt, ok := newDiskDERPMapCache(directory).Get(url)
	if !ok {
		t.Fatal("persisted DERP map was not found")
	}
	if !bytes.Equal(stored, data) || etag != `"etag-1"` || storedAt.IsZero() {
		t.Fatalf("unexpected cache entry: data=%q etag=%q storedAt=%v", stored, etag, storedAt)
	}
	info, err := os.Stat(first.entryPath(url))
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("cache mode = %o, want 600", got)
	}
}

func TestDiskDERPMapCacheRejectsCorruptAndOversizedEntries(t *testing.T) {
	directory := t.TempDir()
	cache := newDiskDERPMapCache(directory)
	url := "https://tailcat.dev/derpmap.json"
	if err := os.WriteFile(cache.entryPath(url), []byte("not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, ok := cache.Get(url); ok {
		t.Fatal("corrupt cache entry was accepted")
	}
	if err := cache.Put(url, make([]byte, maxDERPMapCacheBytes+1), ""); err == nil {
		t.Fatal("oversized DERP map was accepted")
	}
	if _, err := os.Stat(filepath.Dir(cache.entryPath(url))); err != nil {
		t.Fatal(err)
	}
}
