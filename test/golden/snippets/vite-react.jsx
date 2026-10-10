<!-- image (lazy) -->
<picture>
  <source type="image/avif" srcSet="/_bytecut/img/photo/photo-640.avif 640w, /_bytecut/img/photo/photo-1280.avif 1280w, /_bytecut/img/photo/photo-1400.avif 1400w" sizes="100vw" />
  <source type="image/webp" srcSet="/_bytecut/img/photo/photo-640.webp 640w, /_bytecut/img/photo/photo-1280.webp 1280w, /_bytecut/img/photo/photo-1400.webp 1400w" sizes="100vw" />
  <img src="/_bytecut/img/photo/photo-1400.webp" width="1400" height="900" alt="" loading="lazy" decoding="async" style={{ backgroundColor: "#d828c8" }} />
</picture>

<!-- image with alt, class and sizes -->
<picture>
  <source type="image/avif" srcSet="/_bytecut/img/photo/photo-640.avif 640w, /_bytecut/img/photo/photo-1280.avif 1280w, /_bytecut/img/photo/photo-1400.avif 1400w" sizes="(min-width: 768px) 50vw, 100vw" />
  <source type="image/webp" srcSet="/_bytecut/img/photo/photo-640.webp 640w, /_bytecut/img/photo/photo-1280.webp 1280w, /_bytecut/img/photo/photo-1400.webp 1400w" sizes="(min-width: 768px) 50vw, 100vw" />
  <img src="/_bytecut/img/photo/photo-1400.webp" width="1400" height="900" alt="A purple field" className="card" loading="lazy" decoding="async" style={{ backgroundColor: "#d828c8" }} />
</picture>

<!-- hero image (priority) -->
<picture>
  <source type="image/avif" srcSet="/_bytecut/img/hero/hero-1280.avif 1280w, /_bytecut/img/hero/hero-2560.avif 2560w" sizes="100vw" />
  <source type="image/webp" srcSet="/_bytecut/img/hero/hero-1280.webp 1280w, /_bytecut/img/hero/hero-2560.webp 2560w" sizes="100vw" />
  <img src="/_bytecut/img/hero/hero-2560.webp" width="2560" height="1378" alt="Skyline" fetchPriority="high" decoding="async" style={{ backgroundColor: "#2828c8" }} />
</picture>

<!-- background video -->
<video width="1280" height="720" poster="/_bytecut/v/clip/clip-poster.avif" autoPlay muted loop playsInline preload="auto" style={{ backgroundColor: "#0808f8" }}>
  <source src="/_bytecut/v/clip/clip-1280.av1.mp4" type='video/mp4; codecs="av01.0.05M.08"' />
  <source src="/_bytecut/v/clip/clip-1280.h264.mp4" type='video/mp4; codecs="avc1.64001f"' />
</video>

<!-- content video -->
<video width="1280" height="720" poster="/_bytecut/v/clip/clip-poster.avif" playsInline controls preload="metadata" style={{ backgroundColor: "#0808f8" }}>
  <source src="/_bytecut/v/clip/clip-1280.av1.mp4" type='video/mp4; codecs="av01.0.05M.08, mp4a.40.2"' />
  <source src="/_bytecut/v/clip/clip-1280.h264.mp4" type='video/mp4; codecs="avc1.64001f, mp4a.40.2"' />
</video>

<!-- GIF replacement -->
<video width="1280" height="720" className="spinner" poster="/_bytecut/v/clip/clip-poster.avif" autoPlay muted loop playsInline preload="auto" style={{ backgroundColor: "#0808f8" }}>
  <source src="/_bytecut/v/clip/clip-1280.av1.mp4" type='video/mp4; codecs="av01.0.05M.08"' />
  <source src="/_bytecut/v/clip/clip-1280.h264.mp4" type='video/mp4; codecs="avc1.64001f"' />
</video>
