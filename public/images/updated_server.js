
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const mysql = require('mysql2');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Load API Keys từ .env
const WIT_AI_ACCESS_TOKEN = process.env.WIT_AI_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Kiểm tra API Key
if (!GEMINI_API_KEY) {
    console.error('❌ LỖI: Chưa có GEMINI_API_KEY trong .env!');
    process.exit(1);
}
if (!WIT_AI_ACCESS_TOKEN) {
    console.error('❌ LỖI: Chưa có WIT_AI_ACCESS_TOKEN trong .env!');
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Kết nối MySQL
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect(err => {
    if (err) {
        console.error('❌ Lỗi kết nối MySQL:', err);
        process.exit(1);
    }
    console.log('✅ Kết nối MySQL thành công!');
});

// Cấu hình multer để upload file
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, 'public', 'images');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        if (extname && mimetype) {
            return cb(null, true);
        } else {
            cb(new Error('Chỉ chấp nhận file ảnh (jpeg, jpg, png)!'));
        }
    },
    limits: { fileSize: 5 * 1024 * 1024 } // Giới hạn kích thước file: 5MB
});

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/admin', express.static('admin'));
app.use('/images', express.static('public/images'));

// Route cho trang chính (chatbot)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route cho trang quản trị
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Hàm định dạng giá theo chuẩn Việt Nam
function formatPrice(price) {
    return price.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' VNĐ';
}

// Hàm truy vấn SQL với Promise
const query = (sql, params) => {
    return new Promise((resolve, reject) => {
        console.log('📋 Truy vấn SQL:', sql);
        console.log('📋 Tham số:', params);
        db.query(sql, params, (err, results) => {
            if (err) {
                console.error('❌ Lỗi truy vấn MySQL:', err);
                reject(err);
            } else {
                resolve(results);
            }
        });
    });
};

// API lấy danh sách sản phẩm từ MySQL (thêm phân trang, tìm kiếm, lọc)
app.get('/products', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const minPrice = parseFloat(req.query.minPrice) || 0;
    let maxPrice = parseFloat(req.query.maxPrice) || Infinity;
    const brand = req.query.brand || '';

    if (maxPrice === Infinity || isNaN(maxPrice)) {
        maxPrice = 999999999;
    }
    if (isNaN(minPrice)) {
        minPrice = 0;
    }

    let whereConditions = [
        `(LOWER(p.name) LIKE LOWER(?) OR LOWER(p.brand) LIKE LOWER(?))`,
        `p.price BETWEEN ? AND ?`
    ];
    let params = [`%${search}%`, `%${search}%`, minPrice, maxPrice];

    if (brand) {
        whereConditions.push(`p.brand = ?`);
        params.push(brand);
    }

    const whereClause = whereConditions.join(' AND ');

    try {
        const products = await query(
            `SELECT p.*, 
                    (SELECT GROUP_CONCAT(promotion_name SEPARATOR '; ') 
                     FROM promotions 
                     WHERE product_id = p.product_id OR product_id IS NULL) AS promotion_names,
                    (SELECT GROUP_CONCAT(feature_name SEPARATOR '; ') 
                     FROM features 
                     WHERE product_id = p.product_id) AS features
             FROM products p 
             WHERE ${whereClause}
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        const formattedProducts = products.map(product => ({
            ...product,
            formattedPrice: formatPrice(product.price)
        }));

        const totalResult = await query(
            `SELECT COUNT(*) as total 
             FROM products p 
             WHERE ${whereClause}`,
            [...params]
        );

        const total = totalResult && totalResult.length > 0 ? totalResult[0].total : 0;

        res.json({ products: formattedProducts, total, page, limit });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi truy vấn dữ liệu.', details: err.message });
    }
});

// API thêm sản phẩm (có upload hình ảnh)
app.post('/admin/products', upload.single('image'), async (req, res) => {
    const { name, brand, description, price, colors, storage, release_date, warranty_period } = req.body;
    const image_url = req.file ? req.file.filename : null;

    if (!name || !brand || !price) {
        return res.status(400).json({ error: 'Tên, thương hiệu và giá là bắt buộc.' });
    }

    try {
        await query(
            `INSERT INTO products (name, brand, description, price, colors, storage, release_date, warranty_period, image_url) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, brand, description, price, colors, storage, release_date, warranty_period, image_url]
        );
        res.json({ message: 'Thêm sản phẩm thành công!' });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi khi thêm sản phẩm.', details: err.message });
    }
});

// API sửa sản phẩm (có upload hình ảnh)
app.put('/admin/products/:id', upload.single('image'), async (req, res) => {
    const productId = req.params.id;
    const { name, brand, description, price, colors, storage, release_date, warranty_period } = req.body;
    const image_url = req.file ? req.file.filename : req.body.image_url;

    if (!name || !brand || !price) {
        return res.status(400).json({ error: 'Tên, thương hiệu và giá là bắt buộc.' });
    }

    try {
        if (req.file) {
            const oldProduct = await query(
                `SELECT image_url FROM products WHERE product_id = ?`,
                [productId]
            );
            if (oldProduct[0]?.image_url) {
                const oldImagePath = path.join(__dirname, 'public', 'images', oldProduct[0].image_url);
                if (fs.existsSync(oldImagePath)) {
                    fs.unlinkSync(oldImagePath);
                }
            }
        }

        const result = await query(
            `UPDATE products 
             SET name = ?, brand = ?, description = ?, price = ?, colors = ?, storage = ?, release_date = ?, warranty_period = ?, image_url = ? 
             WHERE product_id = ?`,
            [name, brand, description, price, colors, storage, release_date, warranty_period, image_url, productId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Sản phẩm không tồn tại.' });
        }

        res.json({ message: 'Cập nhật sản phẩm thành công!' });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi khi cập nhật sản phẩm.', details: err.message });
    }
});

// API xóa sản phẩm
app.delete('/admin/products/:id', async (req, res) => {
    const productId = req.params.id;

    try {
        const product = await query(
            `SELECT image_url FROM products WHERE product_id = ?`,
            [productId]
        );
        if (product[0]?.image_url) {
            const imagePath = path.join(__dirname, 'public', 'images', product[0].image_url);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
        }

        const result = await query(
            `DELETE FROM products WHERE product_id = ?`,
            [productId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Sản phẩm không tồn tại.' });
        }

        res.json({ message: 'Xóa sản phẩm thành công!' });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi khi xóa sản phẩm.', details: err.message });
    }
});

// Chạy server
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`);
});
