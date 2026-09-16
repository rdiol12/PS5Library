#pragma once
#include <json-c/json.h>
#include <string>
#include <stdexcept>
#include <initializer_list>
#include <utility>

class Json {
  json_object* value_ = nullptr;
  explicit Json(json_object* value) : value_(value) {}
public:
  Json() = default;
  Json(const char* value) : value_(json_object_new_string(value)) {}
  Json(const std::string& value) : Json(value.c_str()) {}
  Json(bool value) : value_(json_object_new_boolean(value)) {}
  Json(int value) : value_(json_object_new_int(value)) {}
  Json(int64_t value) : value_(json_object_new_int64(value)) {}
  Json(const Json& value) : value_(json_object_get(value.value_)) {}
  Json(Json&& value) noexcept : value_(std::exchange(value.value_, nullptr)) {}
  Json& operator=(Json value) { std::swap(value_, value.value_); return *this; }
  ~Json() { json_object_put(value_); }
  static Json object(std::initializer_list<std::pair<std::string,Json>> items = {}) { Json result(json_object_new_object()); for (auto& [key,value] : items) result.set(key,value); return result; }
  static Json array() { return Json(json_object_new_array()); }
  static Json parse(const std::string& text) {
    json_tokener* parser = json_tokener_new_ex(32);
    auto* value = json_tokener_parse_ex(parser,text.c_str(),static_cast<int>(text.size()+1));
    auto error = json_tokener_get_error(parser); auto used = json_tokener_get_parse_end(parser); json_tokener_free(parser);
    if (error != json_tokener_success || text.find_first_not_of(" \r\n\t",used) != std::string::npos) { json_object_put(value); throw std::runtime_error("Invalid JSON"); }
    return Json(value);
  }
  std::string dump() const { return value_ ? json_object_to_json_string_ext(value_,JSON_C_TO_STRING_PLAIN) : "null"; }
  std::string string(const std::string& fallback="") const { return json_object_is_type(value_,json_type_string) ? json_object_get_string(value_) : fallback; }
  int64_t number(int64_t fallback=0) const { return json_object_is_type(value_,json_type_int) ? json_object_get_int64(value_) : fallback; }
  bool boolean() const { return json_object_is_type(value_,json_type_boolean) && json_object_get_boolean(value_); }
  bool null() const { return value_==nullptr; }
  size_t size() const { return json_object_is_type(value_,json_type_array) ? json_object_array_length(value_) : 0; }
  Json operator[](const char* key) const { json_object* value=nullptr; if(json_object_is_type(value_,json_type_object)) json_object_object_get_ex(value_,key,&value); return Json(json_object_get(value)); }
  Json operator[](size_t index) const { return Json(json_object_get(index<size()?json_object_array_get_idx(value_,index):nullptr)); }
  void set(const std::string& key,const Json& value) { if(!json_object_is_type(value_,json_type_object)) throw std::runtime_error("Expected JSON object"); json_object_object_add(value_,key.c_str(),json_object_get(value.value_)); }
  void add(const Json& value) { if(!json_object_is_type(value_,json_type_array)) throw std::runtime_error("Expected JSON array"); json_object_array_add(value_,json_object_get(value.value_)); }
};
