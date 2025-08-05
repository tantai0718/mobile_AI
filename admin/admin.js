// Tải danh sách sản phẩm
async function loadProducts() {
    try {
        const response = await fetch('/products?page=1&limit=100');
        const data = await response.json();
        const productList = document.getElementById('productList');
        productList.innerHTML = '';

        data.products.forEach(product => {
            productList.innerHTML += `
                <tr>
                    <td>${product.product_id}</td>
                    <td>${product.name}</td>
                    <td>${product.brand}</td>
                    <td>${product.price.toLocaleString()} VNĐ</td>
                    <td><img src="/images/${product.image_url}" alt="${product.name}" width="50"></td>
                    <td>
                        <button onclick="showEditForm(${product.product_id}, '${product.name}', '${product.brand}', '${product.description}', ${product.price}, '${product.colors}', '${product.storage}', '${product.release_date}', ${product.warranty_period}, '${product.image_url}')">Sửa</button>
                        <button onclick="deleteProduct(${product.product_id})">Xóa</button>
                    </td>
                </tr>
            `;
        });
    } catch (error) {
        console.error('❌ Lỗi tải sản phẩm:', error);
        alert('Lỗi khi tải danh sách sản phẩm.');
    }
}

// Hiển thị form thêm sản phẩm
function showAddForm() {
    document.getElementById('productForm').style.display = 'block';
    document.getElementById('formTitle').textContent = 'Thêm sản phẩm';
    document.getElementById('productId').value = '';
    document.getElementById('productName').value = '';
    document.getElementById('productBrand').value = '';
    document.getElementById('productDescription').value = '';
    document.getElementById('productPrice').value = '';
    document.getElementById('productColors').value = '';
    document.getElementById('productStorage').value = '';
    document.getElementById('productReleaseDate').value = '';
    document.getElementById('productWarranty').value = '';
    document.getElementById('productImage').value = ''; // Reset input file
    document.getElementById('currentImage').style.display = 'none';
    document.getElementById('formSubmit').onclick = addProduct;
}

// Hiển thị form sửa sản phẩm
function showEditForm(id, name, brand, description, price, colors, storage, release_date, warranty_period, image_url) {
    document.getElementById('productForm').style.display = 'block';
    document.getElementById('formTitle').textContent = 'Sửa sản phẩm';
    document.getElementById('productId').value = id;
    document.getElementById('productName').value = name;
    document.getElementById('productBrand').value = brand;
    document.getElementById('productDescription').value = description || '';
    document.getElementById('productPrice').value = price;
    document.getElementById('productColors').value = colors || '';
    document.getElementById('productStorage').value = storage || '';
    document.getElementById('productReleaseDate').value = release_date || '';
    document.getElementById('productWarranty').value = warranty_period || '';
    document.getElementById('productImage').value = ''; // Reset input file
    document.getElementById('currentImage').style.display = 'block';
    document.getElementById('currentImage').innerHTML = `Ảnh hiện tại: <img src="/images/${image_url}" alt="Current Image" width="100">`;
    document.getElementById('formSubmit').onclick = () => editProduct(id, image_url);
}

// Ẩn form
function hideForm() {
    document.getElementById('productForm').style.display = 'none';
}

// Thêm sản phẩm
async function addProduct() {
    const formData = new FormData();
    formData.append('name', document.getElementById('productName').value);
    formData.append('brand', document.getElementById('productBrand').value);
    formData.append('description', document.getElementById('productDescription').value);
    formData.append('price', document.getElementById('productPrice').value);
    formData.append('colors', document.getElementById('productColors').value);
    formData.append('storage', document.getElementById('productStorage').value);
    formData.append('release_date', document.getElementById('productReleaseDate').value);
    formData.append('warranty_period', document.getElementById('productWarranty').value);
    const imageFile = document.getElementById('productImage').files[0];
    if (imageFile) {
        formData.append('image', imageFile);
    }

    try {
        const response = await fetch('/admin/products', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (response.ok) {
            alert(data.message);
            hideForm();
            loadProducts();
        } else {
            alert(data.error);
        }
    } catch (error) {
        console.error('❌ Lỗi thêm sản phẩm:', error);
        alert('Lỗi khi thêm sản phẩm.');
    }
}

// Sửa sản phẩm
async function editProduct(id, currentImageUrl) {
    const formData = new FormData();
    formData.append('name', document.getElementById('productName').value);
    formData.append('brand', document.getElementById('productBrand').value);
    formData.append('description', document.getElementById('productDescription').value);
    formData.append('price', document.getElementById('productPrice').value);
    formData.append('colors', document.getElementById('productColors').value);
    formData.append('storage', document.getElementById('productStorage').value);
    formData.append('release_date', document.getElementById('productReleaseDate').value);
    formData.append('warranty_period', document.getElementById('productWarranty').value);
    const imageFile = document.getElementById('productImage').files[0];
    if (imageFile) {
        formData.append('image', imageFile);
    } else {
        formData.append('image_url', currentImageUrl); // Gửi image_url hiện tại nếu không upload ảnh mới
    }

    try {
        const response = await fetch(`/admin/products/${id}`, {
            method: 'PUT',
            body: formData
        });
        const data = await response.json();
        if (response.ok) {
            alert(data.message);
            hideForm();
            loadProducts();
        } else {
            alert(data.error);
        }
    } catch (error) {
        console.error('❌ Lỗi sửa sản phẩm:', error);
        alert('Lỗi khi sửa sản phẩm.');
    }
}

// Xóa sản phẩm
async function deleteProduct(id) {
    if (!confirm('Bạn có chắc chắn muốn xóa sản phẩm này?')) return;

    try {
        const response = await fetch(`/admin/products/${id}`, {
            method: 'DELETE'
        });
        const data = await response.json();
        if (response.ok) {
            alert(data.message);
            loadProducts();
        } else {
            alert(data.error);
        }
    } catch (error) {
        console.error('❌ Lỗi xóa sản phẩm:', error);
        alert('Lỗi khi xóa sản phẩm.');
    }
}

// Tải danh sách sản phẩm khi trang được tải
document.addEventListener('DOMContentLoaded', loadProducts);