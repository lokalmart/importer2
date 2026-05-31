# Fix iframe Odoo → Vercel

Jika Odoo menampilkan error `refused to connect` / `ERR_BLOCKED_BY_RESPONSE`, lakukan:

1. Pastikan yang di-embed adalah Production Domain Vercel, bukan deployment preview URL yang panjang.
2. Di Vercel: Project → Settings → Deployment Protection → matikan protection untuk Production / gunakan production domain publik.
3. Gunakan `vercel.json` di paket ini agar response mengizinkan iframe dari `https://edu-lokalmart.odoo.com` melalui CSP `frame-ancestors`.
4. Redeploy project setelah mengganti file.

Contoh iframe QWeb/Odoo:

```xml
<section class="container py-4">
    <div class="row justify-content-center">
        <div class="col-12">
            <div style="border-radius:24px; overflow:hidden; border:1px solid rgba(0,0,0,.12); min-height:900px;">
                <iframe
                    src="https://NAMA-PRODUCTION-DOMAIN-ANDA.vercel.app"
                    style="width:100%; height:920px; border:0;"
                    loading="lazy"
                    referrerpolicy="no-referrer-when-downgrade">
                </iframe>
            </div>
        </div>
    </div>
</section>
```
